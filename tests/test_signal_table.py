"""信号表体检: `SIGNAL_IDS` 不能有重复键。

为什么需要
----------
2026-09-27 踩过: `SIGNAL_IDS` 里 `"3713"`(空调模式)被定义了两次 ——
后面那条 `raw_3713` 悄悄覆盖了 `climate_mode`, 空调模式回读永远是空,
界面上看不出错(有"假定状态"兜底), 只有翻代码才发现。

    python -m pytest tests/test_signal_table.py -q
"""
import ast
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / "poller" / "api_client.py"


def _dict_literal(name: str) -> ast.Dict:
    tree = ast.parse(SRC.read_text(encoding="utf-8"), filename=str(SRC))
    for node in tree.body:                      # 只看模块级赋值
        if isinstance(node, ast.AnnAssign):     # SIGNAL_IDS: dict[str, str] = {...}
            targets = [node.target]
        elif isinstance(node, ast.Assign):      # SIGNAL_IDS = {...}
            targets = node.targets
        else:
            continue
        if any(isinstance(t, ast.Name) and t.id == name for t in targets) \
                and isinstance(node.value, ast.Dict):
            return node.value
    raise AssertionError(f"{name} 不是模块级的字典字面量")


def test_signal_ids_has_no_duplicate_keys():
    d = _dict_literal("SIGNAL_IDS")
    seen: dict[str, int] = {}
    dupes: list[str] = []
    for i, key in enumerate(d.keys):
        assert isinstance(key, ast.Constant) and isinstance(key.value, str), "键必须是字符串字面量"
        if key.value in seen:
            dupes.append(f"信号 {key.value} 在第 {seen[key.value] + 1} 与第 {i + 1} 项重复")
        seen[key.value] = i
    assert not dupes, "SIGNAL_IDS 有重复键(后者会覆盖前者): " + "; ".join(dupes)


def test_signal_ids_values_are_unique_and_nonempty():
    d = _dict_literal("SIGNAL_IDS")
    vals = [k.value for k in d.values if isinstance(k, ast.Constant)]
    assert all(isinstance(v, str) and v for v in vals), "字段名不能为空"
    dupes = {v for v in vals if vals.count(v) > 1}
    assert not dupes, f"字段名重复: {sorted(dupes)}"
