"""实体模块的静态体检: `self._xxx` 必须有赋值处。

为什么需要
----------
2026-09-27 踩过一次: `number.py` 里写了 `self._key`(用于 remember/recall),
但 `LeapmotorSeat.__init__` 从没给它赋值 —— 基类只存 `_attr_unique_id`。
后果是 4 个座椅实体在运行时抛 `AttributeError` 变成 unavailable, 而单测
(只测纯逻辑)完全没拦住。这个测试用 AST 做静态检查, 把这类问题挡在提交前。

规则
----
* 只检查 `custom_components/leapmotor/` 下的实体模块
* 读到 `self._x` 但整个文件里没有 `self._x = ...`(且不是 `_attr_` 前缀、
  也不在 HA 基类属性白名单里)→ 报错

    python -m pytest tests/test_entity_attrs.py -q
"""
from __future__ import annotations

import ast
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
PKG = ROOT / "custom_components" / "leapmotor"

# HA 基类/框架提供的属性(不是我们赋值的), 以及本项目的基类属性
INHERITED = {
    "hass", "_hass", "platform", "_platform", "entity_id", "_context",
    "coordinator", "_config", "async_write_ha_state", "schedule_update_ha_state",
    "async_on_remove", "registry_entry", "device_entry", "unique_id",
    "state", "available", "name", "should_poll",
}
# `_attr_xxx` 是 HA 的声明式属性(类级赋值, 不在 __init__ 里), 一律放行
ATTR_PREFIX = "_attr_"

# 只扫实体/平台模块 —— config_flow/coordinator 大量调用 HA 基类方法,
# 静态检查会误报, 而且它们不在本次要防的 bug 类型里。
ENTITY_MODULES = [
    "entity.py", "lock.py", "climate.py", "switch.py", "number.py", "time.py",
    "button.py", "sensor.py", "device_tracker.py", "image.py", "text.py",
]


def _scan(path: pathlib.Path) -> tuple[set[str], set[str]]:
    """返回 (可用名字, 被读取的名字)。可用 = 实例赋值 ∪ 类级赋值 ∪ 方法/属性名。"""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    assigned: set[str] = set()
    read: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for tgt in targets:
                if isinstance(tgt, ast.Attribute) and isinstance(tgt.value, ast.Name) \
                        and tgt.value.id == "self":
                    assigned.add(tgt.attr)                      # self.x = ...
                elif isinstance(tgt, ast.Name):
                    assigned.add(tgt.id)                        # 类级常量 x = ...
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            assigned.add(node.name)                             # 方法 / @property
        elif isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) \
                and node.value.id == "self" and isinstance(node.ctx, ast.Load):
            read.add(node.attr)
    return assigned, read


def test_entity_modules_only_read_assigned_self_attributes():
    problems: list[str] = []
    # 只看实体/平台模块 —— config_flow/coordinator 大量调用 HA 基类方法,
    # 静态检查会误报(它们不在本次要防的 bug 类型里)。
    for name in ENTITY_MODULES:
        path = PKG / name
        if not path.exists():
            continue
        assigned, read = _scan(path)
        for attr in sorted(read):
            if attr in assigned or attr in INHERITED or attr.startswith(ATTR_PREFIX):
                continue
            problems.append(f"{name}: self.{attr} 被读取但从未赋值")
    assert not problems, "实体模块里有未定义的属性:\n  " + "\n  ".join(problems)


def test_scan_actually_detects_a_missing_attribute(tmp_path):
    """自检: 确认这套检查真的能抓到(否则测试本身就是摆设)。"""
    bad = tmp_path / "bad.py"
    bad.write_text(
        "class X:\n"
        "    def f(self):\n"
        "        return self._never_assigned\n",
        encoding="utf-8",
    )
    assigned, read = _scan(bad)
    assert "_never_assigned" in read and "_never_assigned" not in assigned


# ── 跨模块的字段名一致性(2026-09-30 真机踩到) ──
# 事故: `trips.py` 给 Trip 实例动态赋了 `distance_source`, 但 dataclass **没声明**该字段
# → 从磁盘载入的历史行程没有这个属性 → `sensor.py` 一读就 AttributeError(实体添加失败)。
# 这类"实体读了对方类里不存在的字段"靠运行时才发现太晚, 静态扫一遍最省事。
def test_sensor_only_reads_fields_declared_on_trip():
    import ast as _ast
    import pathlib as _pathlib

    root = _pathlib.Path(__file__).resolve().parent.parent / "custom_components" / "leapmotor"
    trips_src = (root / "trips.py").read_text(encoding="utf-8")
    tree = _ast.parse(trips_src)
    fields: set[str] = set()
    for node in _ast.walk(tree):
        if isinstance(node, _ast.ClassDef) and node.name == "Trip":
            for stmt in node.body:
                if isinstance(stmt, _ast.AnnAssign) and isinstance(stmt.target, _ast.Name):
                    fields.add(stmt.target.id)
    assert "distance_source" in fields, "Trip 必须声明 distance_source"

    sensor_src = (root / "sensor.py").read_text(encoding="utf-8")
    used = {m.group(1) for m in __import__("re").finditer(r"\btrip\.(\w+)", sensor_src)}
    missing = sorted(a for a in used if a not in fields)
    assert not missing, f"sensor.py 读了 Trip 上不存在的字段: {missing}"
