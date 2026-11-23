"""静态卡片 URL 与旧仪表盘资源的迁移。"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from homeassistant.components.lovelace.resources import ResourceStorageCollection

CARD_URL_STATIC = "/leapmotor-card/"


async def async_ensure_card_resource(resources: ResourceStorageCollection, url: str) -> None:
    """登记模块，已有的旧镜像资源保留 ID 并更新 URL。"""
    path = url.partition("?")[0]
    legacy_path = "/local" + path
    matches = []
    for item in resources.async_items():
        item_path = (item.get("url") or "").partition("?")[0]
        if item_path in (path, legacy_path):
            matches.append((item, item_path))

    if not matches:
        await resources.async_create_item({"res_type": "module", "url": url})
        return

    resource = next((item for item, item_path in matches if item_path == legacy_path), matches[0][0])
    resource_id = resource["id"]
    if resource["url"] != url:
        await resources.async_update_item(resource_id, {"url": url})
    for item, _ in matches:
        if item["id"] != resource_id:
            await resources.async_delete_item(item["id"])
