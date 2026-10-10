"""把 `custom_components/leapmotor/` 部署到一台 HA 主机(通过 SSH)。

凭据**不进仓库** —— 从环境变量读:

    HA_HOST=<你的 HA 地址> HA_USER=hassio HA_PASSWORD=... python tools/deploy_ha.py
    ... --restart        # 上传后重启 HA core
    ... --check          # 上传后打印 leapmotor 域的实体数量

默认只上传自定义集成(不碰附加组件)。HA 的 config 目录默认 /config。
"""
from __future__ import annotations

import argparse
import os
import posixpath
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "custom_components" / "leapmotor"
FILES = [
    "__init__.py", "api.py", "const.py", "coordinator.py", "entity.py",
    "config_flow.py", "lock.py", "climate.py", "switch.py", "number.py",
    "time.py", "button.py", "sensor.py", "device_tracker.py", "image.py", "text.py",
    "trips.py", "energy_daily.py", "cardfiles.py", "ws_api.py",
    "manifest.json", "strings.json",
    # HA 2025.2+ 的本地品牌图(集成页显示项目图标)
    "brand/icon.png", "brand/logo.png",
    # 自带的前端卡片(注册为全局 Lovelace 模块, 用户不用手动放 www/)
    "www/leapmotor-map.js",
    "www/leapmotor-trips.js",
    "www/leapmotor-control.js",
    "www/leapmotor-energy.js",
    "www/leapmotor-lastweek.js",
    # 车模图(按车型的官方外观图; 控制卡按设备 model 引用 /leapmotor-card/carimg/<车型>.png)
    "www/carimg/b10.png",
    "www/carimg/c01.png",
    "www/carimg/c10.png",
    "www/carimg/c11.png",
    "www/carimg/c16.png",
    "www/carimg/t.png",
    # 座舱俯视底图(5座/7座 × 浅/深; 座椅与加热卡用)
    "www/carimg/cabin5_light.jpg",
    "www/carimg/cabin5_dark.jpg",
    "www/carimg/cabin7_light.jpg",
    "www/carimg/cabin7_dark.jpg",
]
TRANS = ["zh-Hans.json", "en.json"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default=os.environ.get("HA_HOST", ""))
    ap.add_argument("--user", default=os.environ.get("HA_USER", "hassio"))
    ap.add_argument("--password", default=os.environ.get("HA_PASSWORD", ""))
    ap.add_argument("--config-dir", default=os.environ.get("HA_CONFIG_DIR", "/config"))
    ap.add_argument("--restart", action="store_true", help="上传后重启 HA")
    ap.add_argument("--check", action="store_true", help="上传后统计实体")
    args = ap.parse_args()
    if not args.host or not args.password:
        print("需要 HA_HOST / HA_PASSWORD(或 --host/--password)", file=sys.stderr)
        return 2

    import paramiko  # 延迟导入: 只有部署时才需要

    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(args.host, username=args.user, password=args.password, timeout=20,
              look_for_keys=False, allow_agent=False)

    def run(cmd: str, stdin_data: bytes | None = None, timeout: int = 300) -> str:
        _, out, err = c.exec_command(cmd, timeout=timeout)
        if stdin_data is not None:
            chan = out.channel
            chan.sendall(stdin_data)
            chan.shutdown_write()
        rc = out.channel.recv_exit_status()
        return (out.read() + err.read()).decode("utf-8", "replace") + f"[rc={rc}]"

    dst = posixpath.join(args.config_dir, "custom_components", "leapmotor")
    # SSH 附加组件里当前用户不是 root(但有无密码 sudo), 所以写文件要过 sudo
    print(run(f"sudo mkdir -p {dst}/translations")[:200])

    # SSH 附加组件默认关掉了 sftp 子系统, 所以走 shell 通道把内容喂给 `cat >`
    n = 0
    for name in FILES:
        p = SRC / name
        if not p.exists():
            continue
        target = posixpath.join(dst, name)
        parent = posixpath.dirname(target)
        if posixpath.dirname(name):
            run(f"sudo mkdir -p {parent}")
        r = run(f"sudo sh -c 'cat > {target}'", p.read_bytes())
        if "[rc=0]" not in r:
            print(f"! {name} 写入失败: {r[:200]}")
        n += 1
    for name in TRANS:
        p = SRC / "translations" / name
        if p.exists():
            r = run(f"sudo sh -c 'cat > {posixpath.join(dst, 'translations', name)}'",
                    p.read_bytes())
            if "[rc=0]" not in r:
                print(f"! translations/{name} 写入失败: {r[:200]}")
            n += 1
    print(f"> 已上传 {n} 个文件 → {dst}")

    if args.restart:
        print("> 重启 HA core(约 1~2 分钟)…")
        print(run("bash -lc 'ha core restart'")[:400])
    if args.check:
        print(run("bash -lc 'ha core check'")[-1500:])
    c.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
