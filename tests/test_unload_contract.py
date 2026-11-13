"""防回归: issue #8 —— 卸载/重载把配置条目卡进不可恢复的 FAILED_UNLOAD。

真机复现(2026-11-14, 本机 HA 2026.9.4; 158MB 原始档案 → 历史导入任务长时间 pending):
两个根因都发生在一次「卸载」里, 共同把条目打进不可恢复状态:

1. `entry.async_on_unload(migration.cancel)`
   HA 的 `async_on_unload` 契约是 `Callable[[], Coroutine | None]`;
   而 `asyncio.Task.cancel()` 返回 **bool**(任务仍 pending 时 True)。
   HA 的 `_async_process_on_unload` 把回调返回值直接交给 create_task →
   `TypeError: a coroutine was expected, got True` → 条目 FAILED_UNLOAD, 只能重启 HA。
   正确做法: `entry.async_create_background_task(...)`(HA 卸载时自动取消并等待)。

2. 本包有 `time.py`(HA 的 time 实体平台), 它在首次 forward setup 时被导入,
   Python 会把子模块挂到**包对象**上 —— 那正是 `__init__.py` 的全局命名空间 →
   原先 `import time` 绑定的标准库 time 被顶掉 → 之后 `__init__.py` 里任何
   `time.time()` 都抛 `AttributeError: module 'custom_components.leapmotor.time'
   has no attribute 'time'`(重载时 setup 直接失败; 卸载时日志出现
   「同步采集卸载事实写入失败: AttributeError」)。

这些测试都是离线的(不需要 HA 运行时), 与 CI 一致。
"""
from __future__ import annotations

import ast
import importlib
import pathlib
import re
import sys
import textwrap

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent
PKG = ROOT / "custom_components" / "leapmotor"
INIT = PKG / "__init__.py"


# 只认 <名字>.py(排除 macOS 打包/同步产生的 `._x.py` 这类 AppleDouble 旁文件)
_PY_FILE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*\.py$")


def _py_files() -> list[pathlib.Path]:
    return [p for p in PKG.glob("*.py") if _PY_FILE.match(p.name)]


def _module_ast(path: pathlib.Path) -> ast.Module:
    return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


def _sibling_module_names() -> set[str]:
    """包内可直接当平台/子模块导入的模块名(不含 __init__)。"""
    return {p.stem for p in _py_files() if p.stem != "__init__"}


# ── 根因 2: 平台模块名遮蔽 __init__ 里的标准库名字 ─────────────────────────
def test_no_stdlib_name_shadowed_by_package_modules():
    """`__init__.py` 的模块级 import 不能与同包模块同名(否则子模块会覆盖它)。

    具体: 包里有 time.py; 写 `import time` 的话, 平台导入后
    `__init__.py` 的全局 time 就变成那个子模块, `time.time()` 直接 AttributeError。
    必须写成 `import time as _time` 之类。
    """
    siblings = _sibling_module_names()
    tree = _module_ast(INIT)
    problems: list[str] = []
    for node in tree.body:                       # 只看模块级 import
        if isinstance(node, ast.Import):
            for alias in node.names:
                top = alias.name.split(".")[0]
                bound = alias.asname or top
                if top in siblings and bound in siblings:
                    problems.append(
                        f"import {alias.name}" + (f" as {alias.asname}" if alias.asname else "")
                        + f" → 绑定名 `{bound}` 与包内 {top}.py 同名, 平台导入后会被子模块顶掉"
                    )
        elif isinstance(node, ast.ImportFrom) and not node.level and node.module:
            for alias in node.names:
                bound = alias.asname or alias.name
                if bound in siblings:
                    problems.append(
                        f"from {node.module} import {alias.name}"
                        + (f" as {alias.asname}" if alias.asname else "")
                        + f" → 绑定名 `{bound}` 与包内同名模块冲突"
                    )
    assert not problems, (
        "包内模块名会遮蔽 __init__.py 的标准库 import(issue #8 根因 2):\n  "
        + "\n  ".join(problems)
    )


def test_time_platform_exists_and_alias_is_used():
    """守卫前提: time.py 是真·平台模块(所以上面那条规则不是无的放矢)。"""
    assert (PKG / "time.py").is_file(), "time.py 平台模块没了? 若真删了可同步放宽本测试"
    src = INIT.read_text(encoding="utf-8")
    assert "import time as _time" in src, "time 必须用别名导入(见 test_no_stdlib_name_shadowed_by_package_modules)"
    # 也不能再出现裸 time.xxx 调用(等价于名字又被标准库/子模块混用)
    tree = _module_ast(INIT)
    bad = [
        node.lineno for node in ast.walk(tree)
        if isinstance(node, ast.Attribute)
        and isinstance(node.value, ast.Name)
        and node.value.id == "time"
    ]
    assert not bad, f"__init__.py 第 {bad} 行仍在用裸 `time.`; 应改成 `_time.`"


def test_platform_module_shadow_mechanism(tmp_path):
    """行为验证: 包内同名子模块确实会覆盖 __init__ 的全局名字, 别名则不受影响。"""
    def make_pkg(name: str, init_src: str) -> None:
        pkg = tmp_path / name
        pkg.mkdir()
        (pkg / "__init__.py").write_text(textwrap.dedent(init_src), encoding="utf-8")
        (pkg / "time.py").write_text("MARK = 'platform module'\n", encoding="utf-8")

    make_pkg("issue8_bare_pkg", """
        import time
        def now():
            return time.time()
    """)
    make_pkg("issue8_alias_pkg", """
        import time as _time
        def now():
            return _time.time()
    """)

    sys.path.insert(0, str(tmp_path))
    modules = ["issue8_bare_pkg", "issue8_bare_pkg.time",
               "issue8_alias_pkg", "issue8_alias_pkg.time"]
    try:
        bare = importlib.import_module("issue8_bare_pkg")
        assert callable(bare.now)
        # 平台子模块被导入后, 包对象的 `time` 属性 = 子模块 → 裸 time.time() 崩掉
        importlib.import_module("issue8_bare_pkg.time")
        with pytest.raises(AttributeError, match="has no attribute 'time'"):
            bare.now()

        alias = importlib.import_module("issue8_alias_pkg")
        importlib.import_module("issue8_alias_pkg.time")
        assert isinstance(alias.now(), float), "别名导入必须不受子模块影响"
    finally:
        for name in modules:
            sys.modules.pop(name, None)
        sys.path.remove(str(tmp_path))


# ── 根因 1: async_on_unload 回调只能返回 None 或协程 ────────────────────────
def _none_returning_functions() -> set[str]:
    """包里所有显式标注 `-> None` 的函数/方法名(可安全用作 on_unload 回调)。"""
    names: set[str] = set()
    for path in _py_files():
        for node in ast.walk(_module_ast(path)):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                ret = node.returns
                if isinstance(ret, ast.Constant) and ret.value is None:
                    names.add(node.name)
    return names


def test_async_on_unload_callbacks_return_none():
    """任何注册进 async_on_unload 的回调都必须是返回 None 的函数。

    HA 会这么做(`config_entries._async_process_on_unload`):
        if job := self._on_unload.pop()(): self.async_create_task(hass, job, ...)
    回调返回值只要不是 None/协程, 就会 `TypeError: a coroutine was expected` →
    条目 FAILED_UNLOAD。最典型踩坑: 直接传 `task.cancel`(返回 bool)。
    """
    none_returning = _none_returning_functions()
    problems: list[str] = []
    for path in _py_files():
        for node in ast.walk(_module_ast(path)):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            if not (isinstance(func, ast.Attribute) and func.attr == "async_on_unload"):
                continue
            where = f"{path.name}:{node.lineno}"
            arg = node.args[0] if node.args else None
            if isinstance(arg, ast.Attribute):
                if arg.attr in ("cancel", "cancel_future", "cancel_all", "cancel_children", "close"):
                    problems.append(
                        f"{where}: 传了 `{ast.unparse(arg)}` —— Task.cancel() 返回 bool, "
                        "必须包一层返回 None 的回调, 或改用 entry.async_create_background_task"
                    )
                elif arg.attr not in none_returning:
                    problems.append(
                        f"{where}: 回调 `{ast.unparse(arg)}` 没有显式 `-> None` 标注, "
                        "无法保证返回 None/协程(HA 会把非 None 返回值当协程)"
                    )
            elif isinstance(arg, ast.Name):
                if arg.id not in none_returning:
                    problems.append(
                        f"{where}: 回调 `{arg.id}` 没有显式 `-> None` 标注, "
                        "无法保证返回 None/协程(HA 会把非 None 返回值当协程)"
                    )
            else:
                problems.append(
                    f"{where}: 不认识的回调形式 `{ast.unparse(arg) if arg else '<空>'}`, "
                    "请用显式 `-> None` 的函数"
                )
    assert not problems, "async_on_unload 契约违规(issue #8 根因 1):\n  " + "\n  ".join(problems)


def test_history_migration_task_is_entry_scoped():
    """历史导入任务必须绑定条目生命周期(卸载时 HA 自动取消并等待)。"""
    tree = _module_ast(INIT)
    entry_scoped = [
        node for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "async_create_background_task"
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == "entry"
    ]
    assert entry_scoped, (
        "历史导入应改用 entry.async_create_background_task(hass, ...): "
        "卸载时 HA 自动取消并等待, 不存在返回值契约问题(issue #8 根因 1)"
    )
