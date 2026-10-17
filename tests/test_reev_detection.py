"""增程判定(REEV)的**接线**防回归 —— 纯逻辑在 tests/test_car_state.py, 这里守"接线"。

背景(0.2.3 的两个问题):
  1. "是不是增程"只在 `sensor.async_setup_entry` 里按**首发帧**算一次 —— 首发帧退化
     (云端抽风/风控)时真增程被判成纯电, 那 4 个燃油实体**永远建不出来**(总续航/燃油块/
     双胶囊一起消失), 只能手动重载集成。现在改为 coordinator 每帧复查 + 记忆 + 重载补建。
  2. 记忆存在 config entry 的 `data["reev"]`。而 `_persist()` 是**重建** data 字典
     (以会话字段为底, 再显式补 car_type/car_nickname/phone) —— 新键漏带就会在每次
     token 续期(约 2 小时)时被悄悄抹掉。这里用静态检查把这条钉住。

测试环境没有 homeassistant 包(不导入集成模块), 所以用 AST 静态检查 —— 与本仓库
`test_entity_attrs.py` 的同类做法一致。
"""
from __future__ import annotations

import ast
import pathlib

PKG = pathlib.Path(__file__).resolve().parent.parent / "custom_components" / "leapmotor"


def _func_src(path: pathlib.Path, name: str) -> str:
    """取某个函数的源码文本(找不到就断言失败)。"""
    text = path.read_text(encoding="utf-8")
    tree = ast.parse(text)
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            return ast.get_source_segment(text, node) or ""
    raise AssertionError(f"{path.name} 里找不到函数 {name}")


def test_persist_carries_the_reev_flag():
    """`_persist()` 必须显式带上 `reev` —— 否则 token 续期时把增程记忆抹掉。

    这正是"重建 data 字典"式持久化的坑: 不是会话字段的键, 漏一个就丢一个。
    """
    src = _func_src(PKG / "coordinator.py", "_persist")
    assert 'data["reev"]' in src, (
        "_persist() 没有把 reev 带进新的 data 字典 —— 每次 token 续期会丢掉增程记忆, "
        "增程车会退回纯电(燃油实体消失)。请照 car_type 的写法补一行。"
    )


def test_reev_is_latched_on_the_coordinator_not_decided_once():
    """增程判定必须挂在 coordinator 上(带记忆), 且每帧复查。"""
    coord = (PKG / "coordinator.py").read_text(encoding="utf-8")
    assert "def _note_reev" in coord, "coordinator 缺少 _note_reev(每帧复查增程判定)"
    assert "resolve_reev(" in coord, "coordinator 应该用带记忆的 resolve_reev()"
    # 复查必须真的被每帧调用(挂在拿到车况之后)
    src = _func_src(PKG / "coordinator.py", "_refresh_car_data")
    assert "self._note_reev()" in src, (
        "拿到了车况却没有复查增程判定 —— 首发帧判错就再也纠不回来了"
    )
    assert "async_schedule_reload" in coord, (
        "判定翻转为增程后需要重载一次, 才能补建那 4 个燃油实体"
    )


def test_sensor_setup_uses_the_latched_flag():
    """平台建实体时必须用 coordinator 上的记忆值, 不能自己拿首发帧现算。"""
    src = _func_src(PKG / "sensor.py", "async_setup_entry")
    assert "_reev = c.reev" in src, (
        "sensor.async_setup_entry 应改用 c.reev(带记忆); "
        "若又写成 is_reev(首发帧), 首发帧退化就会永久漏建燃油实体"
    )
    assert "is_reev(st0" not in src and "is_reev(st0.signals" not in src, (
        "不要再用首发帧现算增程判定"
    )


def test_reev_marker_is_exposed_for_the_cards():
    """「续航」实体要暴露稳定的 `reev` 标记 —— 控车卡靠它判断, 不靠燃油实体在不在。"""
    text = (PKG / "sensor.py").read_text(encoding="utf-8")
    tree = ast.parse(text)
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.name == "LeapmotorRange":
            seg = ast.get_source_segment(text, node) or ""
            assert '"reev"' in seg, (
                "LeapmotorRange 没有暴露 reev 属性 —— 控车卡会退回"
                '"燃油实体在不在"这种脆弱判据'
            )
            return
    raise AssertionError("sensor.py 里找不到 LeapmotorRange")


# ── 手动能源类型(选项) ─────────────────────────────────────────────
# 背景(车主反馈): 一辆没有油箱的纯电车报了假的油量, 旧判据把它误判成增程并**记住**了 ——
# 自动判定不可能覆盖所有车型, 必须给车主一个"我说了算"的开关, 且人工判定优先于自动。

def test_energy_option_exists_and_wins_over_auto():
    """选项「能源类型」要真的接进判定: 纯电 → 不建燃油实体, 增程 → 强制建。"""
    conf = pathlib.Path(__file__).resolve().parent.parent / \
        "custom_components" / "leapmotor" / "config_flow.py"
    flow = conf.read_text(encoding="utf-8")
    assert "CONF_ENERGY_TYPE" in flow, "配置流程里没有「能源类型」选项"
    assert 'translation_key="energy_type"' in flow, "能源类型选择器缺少翻译键"

    coord = (PKG / "coordinator.py").read_text(encoding="utf-8")
    init_src = _func_src(PKG / "coordinator.py", "__init__")
    assert "_energy_pref_is_reev()" in init_src, (
        "coordinator 初始化没有按选项决定 reev —— 手动选了纯电也照样会建燃油实体"
    )
    pref_src = _func_src(PKG / "coordinator.py", "_energy_pref_is_reev")
    assert "ENERGY_REEV" in pref_src and "ENERGY_BEV" in pref_src, (
        "手动选的能源类型必须能推翻自动判定(增程强制 True / 纯电强制 False)"
    )
    note = _func_src(PKG / "coordinator.py", "_note_reev")
    assert "ENERGY_BEV" in note, (
        "_note_reev 没有为「纯电」设置短路 —— 车主手动选纯电后, 一次自动判定又会把它升回增程"
    )


def test_persist_clears_latch_when_bev_chosen():
    """选「纯电」时顺手清掉自动判定的记忆 —— 否则切回「自动」会把误判捡回来。"""
    src = _func_src(PKG / "coordinator.py", "_persist")
    assert "ENERGY_BEV" in src, "_persist 没有处理手动选「纯电」的情形(记忆没清)"
