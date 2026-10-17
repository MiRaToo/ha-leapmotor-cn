"""防回归: 卡片**版本号**必须三处一致, 且构建产物与源码同步。

背景:
  * 版本号会拼进 Lovelace 资源的 `?v=`(见 __init__.py), 前端靠它做缓存刷新 ——
    若 JS 里改了版本、Python 侧没改(或反之), 用户就会**继续拿旧文件**, 表现为
    "改了前端但没生效"。历史上真出现过漂移, 当时纯靠人肉同步。
  * 卡片源码现在在 src/(TS+Lit), 产物在 custom_components/leapmotor/www/*.js。
    产物必须与 src 同步, 否则仓库里跑的是旧代码。

本测试覆盖:
  1. src/lib/version.ts 的 CARD_VERSIONS 与 __init__.py 的 5 个常量逐项相等;
  2. 每个产物文件里都能找到它自己的版本号字符串(说明产物确实是这份源码构建的);
  3. (尽力)产物里不含 `import` 语句 —— 自包含约束(需要 node/构建过; 拿不到就跳过)。

纯 Python 可跑(不依赖 node), 保证 CI 上一定执行。
"""
from __future__ import annotations

import pathlib
import re

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent
INIT = ROOT / "custom_components" / "leapmotor" / "__init__.py"
VERSION_TS = ROOT / "src" / "lib" / "version.ts"
WWW = ROOT / "custom_components" / "leapmotor" / "www"

# 卡片名 → (__init__.py 常量名, 产物文件名)
CARDS = {
    "map": ("CARD_VERSION", "leapmotor-map.js"),
    "trips": ("TRIPS_CARD_VERSION", "leapmotor-trips.js"),
    "control": ("CONTROL_CARD_VERSION", "leapmotor-control.js"),
    "energy": ("ENERGY_CARD_VERSION", "leapmotor-energy.js"),
    "lastweek": ("LASTWEEK_CARD_VERSION", "leapmotor-lastweek.js"),
}


def _py_versions() -> dict[str, str]:
    src = INIT.read_text(encoding="utf-8")
    out: dict[str, str] = {}
    for name, (const, _f) in CARDS.items():
        m = re.search(rf'^{re.escape(const)}\s*=\s*"([^"]+)"', src, re.MULTILINE)
        assert m, f"__init__.py 里找不到常量 {const}"
        out[name] = m.group(1)
    return out


def _ts_versions() -> dict[str, str]:
    src = VERSION_TS.read_text(encoding="utf-8")
    out: dict[str, str] = {}
    for name in CARDS:
        m = re.search(rf'\b{name}\s*:\s*"([^"]+)"', src)
        assert m, f"version.ts 里找不到 {name} 的版本"
        out[name] = m.group(1)
    return out


@pytest.mark.parametrize("name", list(CARDS))
def test_versions_match_between_ts_and_python(name: str) -> None:
    py = _py_versions()
    ts = _ts_versions()
    assert ts[name] == py[name], (
        f"{name} 版本号不一致: src/lib/version.ts={ts[name]} vs "
        f"__init__.py={py[name]}(改一处时务必同步另一处, 否则前端拿到旧缓存)"
    )


@pytest.mark.parametrize("name", list(CARDS))
def test_bundle_contains_its_version(name: str) -> None:
    """产物里应能找到自己的版本号 —— 证明 www/ 里是这份源码构建出来的。"""
    _const, fname = CARDS[name]
    path = WWW / fname
    if not path.is_file():
        pytest.skip(f"{fname} 不存在(未构建?)")
    text = path.read_text(encoding="utf-8", errors="replace")
    ver = _ts_versions()[name]
    assert ver in text, (
        f"{fname} 里找不到版本号 {ver} —— 产物可能没跟着源码重新构建, "
        f"请运行 `npm run build`"
    )


@pytest.mark.parametrize("name", list(CARDS))
def test_bundle_has_no_imports(name: str) -> None:
    """产物必须是**自包含**的: 不含任何 ESM import(否则会去请求外部/其它文件)。"""
    _const, fname = CARDS[name]
    path = WWW / fname
    if not path.is_file():
        pytest.skip(f"{fname} 不存在(未构建?)")
    text = path.read_text(encoding="utf-8", errors="replace")
    # 只看真正的模块导入语句, 避开 DOM API 里 "importNode(" / 字符串里的 "important" 等
    bad = re.findall(r'(?<![\w.])import\s*[(\{"\']', text)
    assert not bad, f"{fname} 含有 import 语句(破坏自包含): {bad[:3]}"
