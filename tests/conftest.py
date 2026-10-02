"""把 poller/ 放到 sys.path, 让测试可以用裸模块名 import(与运行时一致)。"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
for _d in ("poller",):
    p = str(ROOT / _d)
    if p not in sys.path:
        sys.path.insert(0, p)
