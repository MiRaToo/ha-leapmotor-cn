"""卡片文件的路径与复制工具 —— **不引用 HA 运行时**, 便于离线单测。

为什么要有"镜像"这一层: 集成的静态路径 `/leapmotor-card/` 要等集成
setup 才注册, 而 HA 重启后前端会立刻重连/刷新 —— 这个窗口里卡片 URL 实测返回 404,
模块加载失败, 卡片就显示「配置错误」, 必须手动刷新才恢复。
把卡片文件**镜像到 `config/www/leapmotor-card/`**(即 `/local/` 前缀 —— 核心早期
注册、内容常驻磁盘的静态目录), 从第二次启动起, 重启窗口内也能取到文件 —— 404 窗口
被彻底消除; 镜像失败时调用方退回 `/leapmotor-card/`, 行为与以前一致。
"""

from __future__ import annotations

import shutil
from pathlib import Path

# 两个 URL 前缀: 集成自带静态路径 / www 镜像(=/local)。两者内容相同, 都是目录。
CARD_URL_STATIC = "/leapmotor-card/"
CARD_URL_LOCAL = "/local/leapmotor-card/"
# 镜像目录名(位于 config/www/ 下); /local 前缀即映射到 config/www/
MIRROR_DIR_NAME = "leapmotor-card"


def card_url_file_name(url: str) -> str:
    """取卡片资源 URL 的文件名(去掉 `?v=` 之类 query)。

    资源登记按**文件名**(而不是完整 URL)匹配: 这样"路径前缀 + 版本号"任一变化都只是
    **更新同一条**, 而不是又建一条; 同名重复条目(历史遗留)会被顺带清掉, 避免同款
    卡片被两个不同 URL 加载两次。
    """
    return str(url or "").split("?", 1)[0].rsplit("/", 1)[-1]


def copy_tree(src: Path, dst: Path) -> None:
    """把 `src` 目录整棵树复制到 `dst`(不存在则创建; 覆盖旧文件; 幂等)。

    供集成在 executor 线程里调用 —— 只做文件 IO, 不碰 HA 对象。
    """
    dst.mkdir(parents=True, exist_ok=True)
    for item in src.iterdir():
        if item.is_dir():
            shutil.copytree(item, dst / item.name, dirs_exist_ok=True)
        elif item.is_file():
            shutil.copy2(item, dst / item.name)


def missing_files(directory: Path, names: list[str]) -> list[str]:
    """`directory` 里还缺哪些文件(判断镜像是否"本次启动前就已存在")。

    为什么在意: `/local` 的 404 响应带 31 天强缓存(HA 2026.9 已知缺陷, 上游
    core#181190)—— 首次启动镜像还没写盘时若把 URL 指过去, 浏览器可能把 404
    缓存 31 天; 所以只有镜像**已经存在**时才切到 `/local`。
    """
    return [n for n in names if not (directory / n).is_file()]
