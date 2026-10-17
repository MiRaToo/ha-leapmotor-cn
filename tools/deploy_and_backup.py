"""把重构后的卡片部署到 HA 实机, 并**先做可撤回备份**。

凭据只从环境变量读(HA_HOST/HA_USER/HA_PASSWORD), 不写进仓库。

流程:
  1. 在 HA 上把现有 /config/custom_components/leapmotor 打包成 tar 备份(带回滚路径)
  2. 上传集成文件(复用 tools/deploy_ha.py 的文件清单与 sudo/cat 写法)
  2b.对齐 config/www/leapmotor-card 镜像 —— 浏览器实际加载的是 /local/leapmotor-card/,
      而镜像只在集成启动时刷新, 不重启就只传集成目录会"新版本号 + 旧文件"
  3. 可选重启(ha core restart)

    HA_HOST=192.168.1.157 HA_USER=hassio HA_PASSWORD=... python tools/deploy_and_backup.py --restart
"""
from __future__ import annotations

import argparse
import hashlib
import os
import posixpath
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from deploy_ha import FILES, TRANS, SRC  # noqa: E402  (复用文件清单)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default=os.environ.get("HA_HOST", ""))
    ap.add_argument("--user", default=os.environ.get("HA_USER", "hassio"))
    ap.add_argument("--password", default=os.environ.get("HA_PASSWORD", ""))
    ap.add_argument("--config-dir", default=os.environ.get("HA_CONFIG_DIR", "/config"))
    ap.add_argument("--restart", action="store_true")
    ap.add_argument("--no-mirror", action="store_true",
                    help="不同步 config/www/leapmotor-card 镜像(默认同步; 见 2b 的说明)")
    args = ap.parse_args()
    if not args.host or not args.password:
        print("需要 HA_HOST / HA_PASSWORD", file=sys.stderr)
        return 2

    import paramiko

    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(args.host, username=args.user, password=args.password, timeout=20,
              look_for_keys=False, allow_agent=False)

    def run(cmd: str, stdin_data: bytes | None = None, timeout: int = 300) -> str:
        _, out, err = c.exec_command(cmd, timeout=timeout)
        if stdin_data is not None:
            ch = out.channel
            ch.sendall(stdin_data)
            ch.shutdown_write()
        rc = out.channel.recv_exit_status()
        return (out.read() + err.read()).decode("utf-8", "replace") + f"[rc={rc}]"

    dst = posixpath.join(args.config_dir, "custom_components", "leapmotor")

    # 集成的 www/(卡片 JS + carimg 外观图): 卡片是按 /local/leapmotor-card/... 取的,
    # 也就是取自镜像; 这里把镜像内容先算好(带 md5, 未变的文件不重写)。
    www = SRC / "www"
    mirror_root = posixpath.join(args.config_dir, "www", "leapmotor-card")
    mirror: list[tuple[str, bytes, str]] = []
    if www.is_dir():
        for p in sorted(www.rglob("*")):
            if p.is_file():
                data = p.read_bytes()
                mirror.append((p.relative_to(www).as_posix(), data, hashlib.md5(data).hexdigest()))
    # 镜像目录还不存在时**不要**由部署脚本创建: 集成那边用"写盘前是否已完整存在"来决定
    # 本次启动用不用 /local(见 _mirror_cards_to_www 的 404 强缓存说明), 抢先建好会让那次启动
    # 误判成"本来就有"。
    mirror_ready = "yes" in run(f"sudo test -d {mirror_root} && echo yes")

    # ── 1. 备份(可撤回) ──
    ts = run("date +%Y%m%d-%H%M%S").split("[rc")[0].strip()
    backup = f"{args.config_dir}/leapmotor-backup-{ts}.tar.gz"
    print("== 备份现有集成 →", backup)
    backup_result = run(f"sudo tar czf {backup} -C {posixpath.dirname(dst)} leapmotor && "
                        f"sudo tar tzf {backup} >/dev/null && sudo ls -la {backup}")
    print(backup_result[:400])
    if not backup_result.endswith("[rc=0]"):
        print("备份或校验失败，未上传任何文件", file=sys.stderr)
        c.close()
        return 1

    # ── 2. 上传 ──
    print("== 上传集成文件")
    print(run(f"sudo mkdir -p {dst}/translations")[:200])
    n = 0
    failed = False
    for name in FILES:
        p = SRC / name
        if not p.exists():
            continue
        target = posixpath.join(dst, name)
        if posixpath.dirname(name):
            run(f"sudo mkdir -p {posixpath.dirname(target)}")
        r = run(f"sudo sh -c 'cat > {target}'", p.read_bytes())
        if "[rc=0]" not in r:
            print(f"! {name} 写入失败: {r[:200]}")
            failed = True
        n += 1
    for name in TRANS:
        p = SRC / "translations" / name
        if p.exists():
            r = run(f"sudo sh -c 'cat > {posixpath.join(dst, 'translations', name)}'", p.read_bytes())
            if "[rc=0]" not in r:
                print(f"! translations/{name} 写入失败")
                failed = True
            n += 1
    print(f"> 已上传 {n} 个文件 → {dst}")
    if failed:
        print("上传不完整，未重启 HA；备份可用于恢复", file=sys.stderr)
        c.close()
        return 1

    # ── 2b. 同步 www 镜像 ──
    # 浏览器实际取的是 /local/leapmotor-card/(集成启动时把 www/ 镜像过去的); 镜像只在
    # **启动时**刷新, 所以"只上传不重启"会让 /local 继续吐旧文件 —— 而 URL 上的 ?v= 已经换了,
    # 浏览器就会把这个旧文件按**新版本号**长期缓存(下次重启后仍是旧的)。故这里顺手对齐。
    if not args.no_mirror and mirror and mirror_ready:
        print("== 同步 www 镜像(/local 的真正来源)")
        files, skipped = 0, 0
        for rel, data, md5 in mirror:
            target = posixpath.join(mirror_root, rel)
            got = run(f"md5sum {target} 2>/dev/null").split(" ")[0].strip()
            if got == md5:
                skipped += 1
                continue
            run(f"sudo mkdir -p {posixpath.dirname(target)}")
            r = run(f"sudo sh -c 'cat > {target}'", data)
            if "[rc=0]" not in r:
                print(f"! 镜像 {rel} 写入失败: {r[:200]}")
                failed = True
            else:
                files += 1
        print(f"> 镜像已对齐({files} 个更新, {skipped} 个未变) → {mirror_root}")
    if failed:
        print("镜像不完整，未重启 HA", file=sys.stderr)
        c.close()
        return 1

    # ── 3. 校验版本已到位 ──
    print("== 主机上的版本常量")
    print(run(f"grep -E 'CARD_VERSION|TRIPS_CARD|CONTROL_CARD|ENERGY_CARD|LASTWEEK_CARD' "
              f"{dst}/__init__.py"))

    if args.restart:
        print("== 重启 HA core(约 1~2 分钟)…")
        print(run("bash -lc 'ha core restart'", timeout=400)[:400])
    c.close()
    print("== 回滚方法: sudo tar xzf", backup, "-C", posixpath.dirname(dst), "后重启 HA")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
