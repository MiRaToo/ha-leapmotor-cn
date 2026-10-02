#!/usr/bin/env python3
"""把 `poller/api_client.py` 同步到集成里(`custom_components/leapmotor/api.py`)。

为什么要同步而不是直接 import:HA 的自定义集成必须自带依赖,不能 import 仓库外的
模块 —— 所以集成里放一份内容相同的副本,`poller/api_client.py` 始终是**唯一真源**。
生成的文件顶部会加一段"勿手改"横幅(内容与源文件逐行相同,只是多了抬头)。

    python tools/sync_api.py          # 同步(有变化才写)
    python tools/sync_api.py --check  # 只检查是否同步(CI 可用, 不同步则退出码 1)
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "poller" / "api_client.py"
DST = ROOT / "custom_components" / "leapmotor" / "api.py"
BANNER = '''"""零跑汽车 API 客户端 —— **本文件由 tools/sync_api.py 从 poller/api_client.py 生成**。

不要直接改这里:改动会在下次同步时被覆盖。请改 poller/api_client.py, 然后跑
    python tools/sync_api.py
"""
'''


def render(src_text: str) -> str:
    """生成集成里那份文件的内容: 横幅 + 源文件正文(去掉源文件自己的 docstring 抬头)。"""
    body = src_text
    if body.startswith('"""'):
        end = body.find('"""', 3)
        if end != -1:
            body = body[end + 3:]
    return BANNER + body.lstrip("\n")


def main() -> int:
    check = "--check" in sys.argv
    if not SRC.exists():
        print(f"! 找不到源文件 {SRC}", file=sys.stderr)
        return 2
    want = render(SRC.read_text(encoding="utf-8"))
    have = DST.read_text(encoding="utf-8") if DST.exists() else ""
    if want == have:
        print("= 已同步:", DST.relative_to(ROOT))
        return 0
    if check:
        print(
            f"! {DST.relative_to(ROOT)} 与 poller/api_client.py 不同步;"
            " 请跑 python tools/sync_api.py",
            file=sys.stderr,
        )
        return 1
    DST.parent.mkdir(parents=True, exist_ok=True)
    DST.write_text(want, encoding="utf-8")
    print("> 已同步:", DST.relative_to(ROOT))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
