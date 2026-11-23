"""把重构后的卡片部署到 HA 实机, 并**先做可撤回备份**。

凭据只从环境变量读(HA_HOST/HA_USER/HA_PASSWORD), 不写进仓库。

流程:
  1. 在 HA 上把现有 /config/custom_components/leapmotor 打包成 tar 备份(带回滚路径)
  2. 上传集成文件(复用 tools/deploy_ha.py 的文件清单与 sudo/cat 写法)
  3. 可选重启(ha core restart)

    HA_HOST=192.168.1.157 HA_USER=hassio HA_PASSWORD=... python tools/deploy_and_backup.py --restart
"""
from __future__ import annotations

import argparse
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
