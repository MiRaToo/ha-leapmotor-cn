"""控制类命令的"乐观状态"契约(源码级回归测试)。

背景(用户反馈): 按下"车窗-关"后命令受理成功, 但界面里的"未关"提醒要等**下一轮停车
轮询**(最多 ~60 秒)才消失 —— 因为 `windows_open` 来自车端信号(1693~1696), 而信号要等
下一帧才更新。修法是命令成功后先按**预期**顶住(集成里锁/空调/开关都在用的 override
机制: 车端回报命令之后的新状态、且过了宽限期就自动失效)。

这类修复很容易在后续重构里被"顺手删掉"(它藏在几个文件里), 所以在这里钉住:
  * button.py: 四个车窗档位 → 预期开/关; 命令成功后 remember + 立即通知监听者;
  * sensor.py: `vehicle_state` 的 windows_open / trunk_open 要经过 recall();
  * switch.py: 开关命令成功后要 remember(否则状态要等车端回报)。

(HA 运行时不在本地测试环境里, 所以这里做源码/AST 级检查 —— 与 test_reload_guard.py 同一思路。)
"""
from __future__ import annotations

import ast
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
PKG = ROOT / "custom_components" / "leapmotor"


def _src(name: str) -> str:
    return (PKG / name).read_text(encoding="utf-8")


def _func(tree: ast.AST, name: str) -> ast.AsyncFunctionDef | ast.FunctionDef:
    for node in ast.walk(tree):
        if isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)) and node.name == name:
            return node
    raise AssertionError("找不到函数 " + name)


def test_window_buttons_remember_expected_state():
    """车窗四档: 命令 → 预期状态; `async_press` 里 remember 必须在 async_call **之后**。"""
    tree = ast.parse(_src("button.py"))
    expect = None
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id == "WINDOW_EXPECT" for t in node.targets):
            expect = ast.literal_eval(node.value)
    assert expect == {"windows_open": True, "windows_vent": True,
                      "windows_half": True, "windows_close": False}, expect

    press = _func(tree, "async_press")
    calls = [n for n in ast.walk(press) if isinstance(n, ast.Call)]
    names = []
    for c in calls:
        fn = c.func
        if isinstance(fn, ast.Attribute):
            names.append((fn.attr, min([getattr(x, "lineno", 0) for x in c.args] or [0])))
    called = [n for n, _ in names]
    assert "async_call" in called, called
    assert "remember" in called, called
    assert "async_update_listeners" in called, called
    line_call = min(l for n, l in names if n == "async_call")
    line_remember = min(l for n, l in names if n == "remember")
    assert line_remember > line_call, "remember 要在命令真正发出之后(否则可能记下未执行的预期)"

    # remember 的 key 与值来自 WINDOW_EXPECT(不能写死成常量)
    remembered = [c for c in calls if isinstance(c.func, ast.Attribute)
                  and c.func.attr == "remember"]
    assert remembered and ast.unparse(remembered[0].args[0]) == "'windows'", ast.unparse(remembered[0])


def test_vehicle_state_attributes_use_overrides():
    """`vehicle_state` 的 windows_open / trunk_open 必须经过 recall(), 否则命令后要等一轮轮询。"""
    src = _src("sensor.py")
    assert 'recall("windows")' in src, "windows_open 没有走乐观状态"
    assert 'recall("trunk")' in src, "trunk_open 没有走乐观状态"
    # 顶住期间四窗状态/开度也要一致(不能 windows_open=False 却报 2/2/2/2)
    assert "win_states" in src and "win_pct" in src
    assert "if wins is False" in src
    # 属性名是卡片/自动化读取的契约, 别改名 —— 只检查 key = "vehicle_state" 那个类
    tree = ast.parse(src)
    cls = None
    for node in tree.body:
        if not isinstance(node, ast.ClassDef):
            continue
        keys = [n.value.value for n in node.body if isinstance(n, ast.Assign)
                and any(isinstance(t, ast.Name) and t.id == "key" for t in n.targets)
                and isinstance(n.value, ast.Constant)]
        if "vehicle_state" in keys:
            cls = node
    assert cls is not None, "找不到 vehicle_state 传感器类"
    func = _func(cls, "extra_state_attributes")
    keys = {k.value for n in ast.walk(func) if isinstance(n, ast.Return)
            for k in (n.value.keys if isinstance(n.value, ast.Dict) else [])
            if isinstance(k, ast.Constant)}
    assert {"windows_open", "trunk_open", "windows_state", "windows_percent"} <= keys, keys


def test_switches_remember_after_command():
    """开关(后备箱/遮阳帘/加热…): 命令成功后 remember, 状态立即跟着命令走。"""
    tree = ast.parse(_src("switch.py"))
    for name in ("async_turn_on", "async_turn_off"):
        func = _func(tree, name)
        attrs = [n.func.attr for n in ast.walk(func)
                 if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)]
        assert "remember" in attrs, (name, attrs)
        assert "async_write_ha_state" in attrs, (name, attrs)
    # `_real` 要优先读 override
    real = _func(tree, "_real")
    assert any(isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
               and n.func.attr == "recall" for n in ast.walk(real)), "is_on 没读 override"
