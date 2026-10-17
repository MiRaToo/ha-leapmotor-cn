"""卡片文件工具(`cardfiles.py`)的单元测试。

背景: 集成的静态路径 `/leapmotor-card/` 要等集成 setup 才注册, HA 重启后前端立刻刷新
页面时, 这些 URL 在窗口期内 404 → 卡片显示「配置错误」。修法是把卡片文件镜像到
`config/www/leapmotor-card/`(核心早期注册的 `/local` 静态目录), 并按"镜像是否已存在"
决定是否切换到 /local URL(因为 /local 的 404 会被缓存很久)。

这里只测**纯函数**(不引 HA 运行时): URL→文件名、目录复制、缺文件检查。
"""
from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "custom_components" / "leapmotor"))

from cardfiles import (CARD_URL_LOCAL, CARD_URL_STATIC, card_url_file_name,  # noqa: E402
                       copy_tree, missing_files, MIRROR_DIR_NAME)


def test_url_prefixes_are_distinct_dirs():
    assert CARD_URL_STATIC == "/leapmotor-card/"
    assert CARD_URL_LOCAL == "/local/leapmotor-card/"
    assert MIRROR_DIR_NAME == "leapmotor-card"


def test_card_url_file_name_strips_query_and_path():
    assert card_url_file_name("/leapmotor-card/leapmotor-control.js?v=1.7.3") == "leapmotor-control.js"
    assert card_url_file_name("/local/leapmotor-card/leapmotor-control.js?v=1.7.3") == "leapmotor-control.js"
    # 两条不同前缀 + 不同版本的同一卡片 → 文件名相同的 → 资源登记会认出"是同一条"
    a = card_url_file_name("/leapmotor-card/leapmotor-map.js?v=1.6.1")
    b = card_url_file_name("/local/leapmotor-card/leapmotor-map.js?v=2.0.0")
    assert a == b == "leapmotor-map.js"
    assert card_url_file_name("") == "" and card_url_file_name(None) == ""


def test_copy_tree_is_idempotent_and_recursive(tmp_path):
    src = tmp_path / "www"
    (src / "carimg").mkdir(parents=True)
    (src / "leapmotor-control.js").write_text("v1", encoding="utf-8")
    (src / "carimg" / "c10.png").write_bytes(b"\x89PNG-old")
    dst = tmp_path / "mirror"

    copy_tree(src, dst)
    assert (dst / "leapmotor-control.js").read_text(encoding="utf-8") == "v1"
    assert (dst / "carimg" / "c10.png").read_bytes() == b"\x89PNG-old"

    # 再复制一次(模拟集成更新后重跑): 内容被覆盖, 不报错、不重复嵌套
    (src / "leapmotor-control.js").write_text("v2", encoding="utf-8")
    (src / "carimg" / "c10.png").write_bytes(b"\x89PNG-new")
    copy_tree(src, dst)
    assert (dst / "leapmotor-control.js").read_text(encoding="utf-8") == "v2"
    assert (dst / "carimg" / "c10.png").read_bytes() == b"\x89PNG-new"
    assert sorted(p.name for p in dst.iterdir()) == ["carimg", "leapmotor-control.js"]


def test_missing_files_reports_only_absent(tmp_path):
    d = tmp_path / "m"
    d.mkdir()
    (d / "a.js").write_text("x", encoding="utf-8")
    assert missing_files(d, ["a.js", "b.js", "c.js"]) == ["b.js", "c.js"]
    # 目录不存在 → 全部缺失
    assert missing_files(tmp_path / "nope", ["a.js"]) == ["a.js"]
    # 都在 → 空
    assert missing_files(d, ["a.js"]) == []
