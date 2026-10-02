#!/usr/bin/env python3
"""生成一份"只暴露零跑汽车实体"的 HomeKit 桥 YAML —— 复制到 configuration.yaml 即可。

为什么需要它
------------
HA 的 HomeKit 桥有两条配置路径:

* **界面**:设置 → 设备与服务 → 添加集成 → HomeKit Bridge。
  但界面的"实体"列表是**按你选的域过滤**的 —— 域留空就一个实体都选不到,
  而且只要选了域,该域下**所有**实体都会被暴露(过滤规则是并集,不是交集)。
* **YAML**(本脚本生成的):只写 `include_entities`、不写 `include_domains`,
  按 HA 过滤规则第 6 条 = "只有列出的实体进入",这才是"只暴露这几个"。

所以:想要"家庭 App 里只有车的配件",就用这份 YAML。

用法
----
    python tools/make_homekit_yaml.py                          # 自动探测实体前缀
    python tools/make_homekit_yaml.py --slug ling_pao_c10_123456
    python tools/make_homekit_yaml.py --port 21065 --name 零跑汽车 > /tmp/homekit.yaml

`--slug` 就是实体 ID 中间那一段(实体形如 `lock.<slug>_che_men_suo`);
不知道的话在 HA 里看一眼任意零跑实体的 entity_id 即可。
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

# 按"实体 key 后缀"列出的推荐清单: (域, key 后缀, 说明)
# key 后缀 = 实体 ID 里 slug 之后的部分, 例如 lock.<slug>_che_men_suo → che_men_suo
RECOMMENDED: list[tuple[str, str, str]] = [
    ("lock", "che_men_suo", "车门锁"),
    ("climate", "kong_diao", "空调"),
    ("switch", "jian_kang_chong_dian", "健康充电"),
    ("switch", "yu_yue_chong_dian", "预约充电"),
    ("switch", "hou_bei_xiang", "后备箱(开关, 2026-09-28 由两个按钮合并而来)"),
    ("switch", "zhe_yang_lian", "遮阳帘(开关, 同上)"),
    ("switch", "fang_xiang_pan_jia_re", "方向盘加热"),
    ("switch", "hou_shi_jing_jia_re", "后视镜加热"),
    ("button", "xun_che_ming_di", "寻车鸣笛"),
    # 车窗是 0~10 四档, HA 里是四个按钮
    ("button", "che_chuang_kai", "车窗-全开"),
    ("button", "che_chuang_wei_kai", "车窗-微开"),
    ("button", "che_chuang_ban_kai", "车窗-半开"),
    ("button", "che_chuang_guan", "车窗-关"),
    ("button", "dian_chi_yu_re_kai", "电池预热-开"),
    ("button", "dian_chi_yu_re_guan", "电池预热-关"),
    ("button", "shua_xin_che_kuang", "刷新车况"),
    ("sensor", "che_nei_wen_du", "车内温度(temperature, HomeKit 支持)"),
]

# 说明: 上面写的是"实体 ID 里 slug 之后那一段", 以你自己 HA 里看到的为准 ——
# 老安装里实体 ID 可能还是旧名字(改名不会改已注册的 entity_id), 例如车窗-全开
# 可能仍叫 ..._che_chuang_kai。哨兵模式**不在清单里**: 零跑主账号无法把哨兵授权
# 给子账号(云端回 code=40), 本集成已移除该实体, 见 docs/PROTOCOL.md §6.2。

# HomeKit 不支持的域(实测 2026-09-27 于 HA + C10: 写进去也不会进桥)
UNSUPPORTED_DOMAINS = {
    "device_tracker": "车辆位置(界面里能选, 但 HomeKit 没有对应配件类型)",
    "time": "预约充电起止时间",
    "image": "驻车照片",
    "text": "原始指令",
    "number": "充电上限 / 座椅加热通风 —— HomeKit **不支持 number 域**",
}
# 传感器里"不会单独出现"的: battery 只作为别的配件的"关联电池"
UNSUPPORTED_SENSORS = [
    ("sensor", "dian_liang", "电量 —— battery 类传感器在 HomeKit 里只作\"关联电池\", 不单独成配件"),
    ("sensor", "xu_hang", "续航(distance, HomeKit 无对应类型)"),
    ("sensor", "tai_ya_zuo_qian", "胎压(pressure, HomeKit 无对应类型)"),
    ("sensor", "zong_li_cheng", "总里程(distance)"),
]

# HomeKit 不支持的域(放进去也不会出现), 仅用于提示
UNSUPPORTED = {
    "device_tracker": "车辆位置(HomeKit 无对应配件类型)",
    "time": "预约充电起止时间",
    "image": "驻车照片",
    "text": "原始指令",
}


def detect_slug(registry: Path | None = None) -> str | None:
    """从实体注册表里猜出零跑实体的 slug(有权限读 .storage 时用)。"""
    if registry and registry.exists():
        import json

        try:
            data = json.loads(registry.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            return None
        for ent in data.get("data", {}).get("entities", []):
            if ent.get("platform") in ("leapmotor", "leapmotor_cn"):
                eid = str(ent.get("entity_id", ""))
                m = re.match(r"[a-z_]+\\.(.+)_che_men_suo$", eid)
                if m:
                    return m.group(1)
    return None


def build(slug: str, name: str, port: int) -> str:
    lines = [
        "# ── 零跑汽车 → HomeKit(独立桥: 只暴露车相关的实体) ──",
        "# 由 tools/make_homekit_yaml.py 生成; 改完重启 HA 生效。",
        "# 注意: YAML 配置的桥在界面上不可编辑, 这是刻意的 ——",
        "#       界面里的\"实体\"列表按\"域\"过滤, 做不到\"只暴露这几个\"。",
        "homekit:",
        f"  - name: {name}",
        f"    port: {port}",
        "    filter:",
        "      include_entities:",
    ]
    for domain, key, label in RECOMMENDED:
        lines.append(f"        - {domain}.{slug}_{key}")          # {label}
    lines.append("")
    lines.append("# 下面这些**不会**出现在家庭 App(HomeKit 的限制, 不是配置错):")
    for domain, key, label in UNSUPPORTED_SENSORS:
        lines.append(f"#   - {domain}.{slug}_{key}   # {label}")
    for domain, why in UNSUPPORTED_DOMAINS.items():
        lines.append(f"#   {domain}: {why}")
    lines += [
        "",
        "# 下面这些域 HomeKit 不支持(放进来也不会出现在家庭 App):",
    ]
    for domain, why in UNSUPPORTED.items():
        lines.append(f"#   {domain}: {why}")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--slug", help="实体 ID 中间那段, 例如 ling_pao_c10_123456")
    ap.add_argument("--name", default="零跑汽车", help="桥的名字(默认 零跑汽车)")
    ap.add_argument("--port", type=int, default=21065,
                    help="桥端口(默认 21065; 要与其它桥不同, 常见桥用 21063/21064)")
    ap.add_argument("--registry", default="/config/.storage/core.entity_registry",
                    help="实体注册表路径(用于自动探测 slug; 读不到就手动传 --slug)")
    args = ap.parse_args()

    slug = args.slug or detect_slug(Path(args.registry))
    if not slug:
        print("! 没能自动探测到实体前缀 —— 请在 HA 里看一眼任意零跑实体的 entity_id,\n"
              "  形如 lock.<这一段>_che_men_suo, 然后用 --slug 传进来。", file=sys.stderr)
        return 2
    print(build(slug, args.name, args.port))
    print(f"# 共 {len(RECOMMENDED)} 个实体; 追加到 configuration.yaml 后重启 HA,"
          f" 再到 设置 → 设备与服务 → HomeKit Bridge({args.name}) 扫码配对。", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
