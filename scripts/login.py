#!/usr/bin/env python3
"""零跑汽车一键登录 —— **纯 HTTP**,不需要模拟器 / root / frida / App。

    ✅ 手机号 + 短信验证码 登录(账号服务)
    ✅ 用账号 token 换车端 JWT + 密钥材料(全局服务)
    ✅ 本地派生车控签名密钥(纯 Python 异或,已实测逐字节吻合)
    ✅ 拉一次车辆列表验证会话可用

全过程与官方 App 走的是同一套接口, 只是不需要装 App。

⚠️ 风控注意事项(实测结论):
    * **不要**传 `smDeviceId` —— 省略时服务端放行;传伪造值会被判"环境高风险"
    * 不要短时间反复重试: `code 1023 您的账号环境疑似高风险` 出现后,
      继续请求会**不断续期**该冷却(我们踩过:90s 轮询把 10 分钟拖成数小时),
      应静默等待 ≥30 分钟再试**一次**
    * 换设备 ID 更容易触发风控, 所以本脚本会复用已存会话里的 device_id

用法:
    python scripts/login.py --phone 138xxxxxxxx
    python scripts/login.py --phone 138xxxxxxxx -o session.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from poller.api_client import (  # noqa: E402
    LeapmotorClient,
    Session,
    new_device_id,
)

RISK_COOLDOWN = 1023      # 环境疑似高风险
SMS_TOO_OFTEN = 36        # 验证码发送频繁
SMS_OK = 200

SUBACCOUNT_NOTICE = """
┌─────────────────────────────────────────────────────────────────────┐
│  ⚠️  请务必使用【子账号】登录,不要用主账号                          │
│                                                                     │
│  零跑云是单账号单会话:本项目持续登录会把手机上的官方 App 顶下线。   │
│  用主账号 → 你自己的手机将无法控车,且每次重连都会再踢一次。         │
│                                                                     │
│  正确做法:                                                          │
│   1. 用另一个手机号注册一个零跑账号(子账号)                       │
│   2. 官方 App(主账号)→ 我的车辆 → 车辆共享/授权用车 → 邀请子账号  │
│   3. 子账号在 App 里接受共享后,再来这里登录                        │
│                                                                     │
│  子账号权限随时可在「车辆共享」里收回,主账号不受影响。              │
└─────────────────────────────────────────────────────────────────────┘
"""


def confirm_subaccount(skip: bool) -> bool:
    """要求用户显式确认使用的是子账号(可用 --yes 跳过,便于自动化)。"""
    print(SUBACCOUNT_NOTICE)
    if skip:
        print("(--yes 已跳过确认)\n")
        return True
    try:
        ans = input("确认你登录的是【子账号】而非主账号?输入 yes 继续: ").strip().lower()
    except EOFError:
        return False
    if ans in ("yes", "y"):
        print()
        return True
    print("\n已取消。请先准备一个子账号并让主账号共享车辆给它 —— 详见 README.zh-CN.md。")
    return False


def load_or_new_session(path: Path) -> Session:
    """尽量复用已有 device_id —— 换设备 ID 更容易触发风控。"""
    if path.is_file():
        try:
            return Session.load(path)
        except Exception:
            pass
    sess = Session()
    sess.device_id = new_device_id()
    return sess


def main() -> int:
    ap = argparse.ArgumentParser(description="零跑 CN 一键登录(纯 HTTP)")
    ap.add_argument("--phone", required=True, help="手机号(请填**子账号**手机号)")
    ap.add_argument("--code", default="", help="短信验证码;给了就非交互执行(适合容器/自动化)")
    ap.add_argument("-o", "--out", default="session.json", help="会话输出文件")
    ap.add_argument("--resend", action="store_true", help="强制重发验证码")
    ap.add_argument("--yes", action="store_true",
                    help="跳过「确认使用子账号」的交互确认(自动化场景)")
    args = ap.parse_args()

    if not confirm_subaccount(args.yes or bool(args.code)):
        return 6

    out = Path(args.out)
    sess = load_or_new_session(out)
    client = LeapmotorClient(sess)
    print(f"设备 ID: {sess.device_id}")

    # ── 1. 发验证码 ──
    print(f"\n正在向 {args.phone} 发送验证码 …")
    r = client.request_sms_code(args.phone)
    code = r.get("code")
    print(f"  响应: code={code} msg={r.get('msg') or r.get('message')}")

    if code == RISK_COOLDOWN:
        print("\n⚠️  账号处于风控冷却中(1023)。")
        print("   原因:短时间内请求过多。**继续请求会不断续期**,请静默等待:")
        print("     · 建议等待 30 分钟以上,期间不要调用任何接口")
        print("     · 之后重新运行本脚本,只尝试一次")
        return 3
    if code == SMS_TOO_OFTEN:
        print("\n⚠️  验证码发送频繁(36),请等待几分钟后重试。")
        return 4
    if code != SMS_OK:
        print(f"\n✗ 发送失败: {json.dumps(r, ensure_ascii=False)}")
        return 1

    print("✅ 验证码已发送,请查看手机短信")

    # ── 2. 输入验证码 → 账号登录 ──
    sms_code = args.code or input("请输入收到的验证码: ").strip()
    if not sms_code:
        print("未输入验证码,退出。")
        return 2

    print("\n[1/3] 账号登录 …")
    resp = client.login(args.phone, sms_code)
    print(f"  响应: code={resp.get('code')} msg={resp.get('msg') or resp.get('message')}")
    if resp.get("code") != 200 or not client.session.token:
        print("\n✗ 登录失败。原始响应(用于排查):")
        print(json.dumps(resp, ensure_ascii=False, indent=2)[:1500])
        if resp.get("code") == RISK_COOLDOWN:
            print("\n(1023 = 风控冷却,请静默等待后重试)")
        return 1
    print(f"  账号 token: 已获得    userId: {sess.user_id}")

    # ── 3. 车端交换 ──
    print("\n[2/3] 换取车端 JWT 与密钥材料 …")
    r2 = client.car_login()
    if not sess.car_token or not sess.sign_param:
        print("✗ 车端登录失败。原始响应:")
        print(json.dumps(r2, ensure_ascii=False, indent=2)[:1500])
        return 1
    print(f"  车端 JWT : {sess.car_token[:40]}…（{len(sess.car_token)} 字符）")
    print(f"  signParam: r2={str(sess.sign_param.get('r2'))[:16]}… r3={str(sess.sign_param.get('r3'))[:16]}…")

    # ── 4. 本地派生签名密钥 ──
    key = sess.seal_key()
    print("\n[3/3] 本地派生签名密钥 …")
    print(f"  HKDFKey  : {key}  ({len(key)//2} 字节)")

    # ── 5. 验证: 拉车辆列表 ──
    print("\n验证: 拉取车辆列表 …")
    try:
        vehicles = client.get_vehicle_list()
    except Exception as e:  # noqa: BLE001
        print(f"  ⚠️ 拉取失败: {e}")
        vehicles = []

    if vehicles:
        for v in vehicles:
            print(f"  ✅ {v.vin}  {v.car_type}  {v.year} 款  {v.nick_name}")
            if v.right_list:
                print(f"     可下发指令({len(v.right_list)} 条): {','.join(v.right_list[:16])}…")
    else:
        print("  ⚠️ 未取到车辆 —— 会话本身可用,请确认子账号已被共享车辆")

    sess.save(out)
    print(f"\n✅ 会话已写入 {out}")
    print("   （含签名密钥;2 小时后过期,届时重跑本脚本即可）")
    print("\n下一步: 把 custom_components/leapmotor/ 放进 HA 的 config/custom_components/, "
          "重启后在 设置 → 设备与服务 里添加「零跑」集成。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
