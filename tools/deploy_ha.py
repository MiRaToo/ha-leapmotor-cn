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
    "trips.py", "energy_daily.py", "charging.py", "charge_plan.py", "fuel_daily.py", "capabilities.py", "market_picture.py", "vehicle_tools.py", "cardfiles.py", "ws_api.py",
    # 3D 车模: 素材懒装配(查看器 + 本车模型, 落到 config/leapmotor-car3d/)
    "car3d.py", "amap.py",
    # 诊断导出 + 脱敏(diag_redact 不引 HA, 便于离线单测)
    "diagnostics.py", "diag_redact.py",
    # 素材采集与 3D 探针服务
    "asset_services.py",
    "manifest.json", "strings.json",
    # 服务声明(「开发者工具 → 服务」的名字/说明/字段都读它; 缺少声明时
    # 没有参数输入框, 只能手写 YAML)
    "services.yaml",
    # HA 2025.2+ 的本地品牌图(集成页显示项目图标)
    "brand/icon.png", "brand/logo.png",
    # 自带的前端卡片(注册为全局 Lovelace 模块, 用户不用手动放 www/)
    "www/leapmotor-map.js",
    "www/leapmotor-trips.js",
    "www/leapmotor-control.js",
    "www/leapmotor-energy.js",
    "www/leapmotor-lastweek.js",
    "www/leapmotor-metrics.js",
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
    # 3D 车模的包装页 + 星空贴图(装配时由 car3d.py 铺进 config/leapmotor-car3d/)
    "www/car3d/view.html",
    "www/car3d/view.js",
    "www/car3d/textures/skybox_night_starry.jpg",
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
    ap.add_argument("--verify", action="store_true",
                    help="只读核验: 确认产物真的落到了 HA 上、版本号对得上、界面风格代码在里面")
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

    if args.verify:
        # 只读核验: 确认产物落到 HA 上、版本号对得上、界面风格代码在里面。
        # 放在上传之前 —— 它不该改动任何东西。
        checks = [
            ("HA core 状态", "bash -lc 'ha core info 2>/dev/null | head -5'"),
            ("卡片产物字节数(应与刚构建的一致)",
             f"sudo sh -c 'wc -c {dst}/www/leapmotor-*.js'"),
            ("控制卡里有没有界面风格代码(应 >=1)",
             f"sudo sh -c \"grep -c 'leapmotor.appearance' {dst}/www/leapmotor-control.js\""),
            ("六张卡里有没有语义变量层(每张都应 >=1)",
             f"sudo sh -c \"grep -c -- '--lm-surface-card' {dst}/www/leapmotor-*.js\""),
            ("Lovelace 资源登记的缓存版本号(应是本次新版本)",
             "sudo sh -c \"grep -o 'leapmotor-[a-z]*\\.js?v=[0-9.]*' "
             f"{posixpath.join(args.config_dir, '.storage/lovelace_resources')} | sort -u\""),
            ("集成加载日志(最后 20 行)",
             "bash -lc 'ha core logs 2>/dev/null | grep -i leapmotor | tail -20'"),
        ]
        for label, cmd in checks:
            print(f"\n── {label} ──")
            print(run(cmd, timeout=120))
        c.close()
        return 0

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
