"""防回归: 前端卡片的 JS 必须能作为 **ES module** 解析。

踩过的坑: 有个改动把字符串拼错(引号不匹配), 生成的文件出现**语法错误**, 整个卡片模块
加载失败 → 元素没注册 → 前端显示"配置错误 / Custom element doesn't exist"。
而 `node --check xxx.js` 对 `.js` 走的是脚本模式, **没报出来**(ESM 才报)。

所以这里把每个卡片复制成 .mjs, 用 `node --check` 以 **ES module 模式**做语法校验。
环境里没有 node 时跳过(不阻塞纯 Python 环境)。
"""
from __future__ import annotations

import pathlib
import shutil
import subprocess
import tempfile

import pytest

WWW = pathlib.Path(__file__).resolve().parent.parent / "custom_components" / "leapmotor" / "www"
CARDS = ["leapmotor-map.js", "leapmotor-trips.js", "leapmotor-control.js",
         "leapmotor-energy.js", "leapmotor-lastweek.js"]


def _node():
    return shutil.which("node") or shutil.which("node.exe")


@pytest.mark.parametrize("name", CARDS)
def test_card_parses_as_es_module(name):
    node = _node()
    if not node:
        pytest.skip("node 不可用, 跳过前端语法校验")
    src = WWW / name
    assert src.is_file(), f"缺少卡片文件 {name}"
    with tempfile.TemporaryDirectory() as d:
        tmp = pathlib.Path(d) / (name[:-3] + ".mjs")   # .mjs → 按 ES module 解析
        tmp.write_bytes(src.read_bytes())
        r = subprocess.run([node, "--check", str(tmp)], capture_output=True, text=True)
    assert r.returncode == 0, f"{name} 语法错误(ES module 模式):\n{r.stdout}\n{r.stderr}"
