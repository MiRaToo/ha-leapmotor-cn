"""验证静态卡片资源的升级与首次登记。"""

from __future__ import annotations

import asyncio
import pathlib
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "custom_components" / "leapmotor"))

from cardfiles import CARD_URL_STATIC, async_ensure_card_resource  # noqa: E402

CONTROL_URL = "/leapmotor-card/leapmotor-control.js?v=1.9.77"
LEGACY_URL = "/local/leapmotor-card/leapmotor-control.js?v=1.9.76"


def _resources(*items):
    return SimpleNamespace(
        async_items=lambda: items,
        async_create_item=AsyncMock(),
        async_update_item=AsyncMock(),
        async_delete_item=AsyncMock(),
    )


def test_migrates_original_id_even_when_static_resource_already_exists():
    resources = _resources(
        {"id": "duplicate", "url": CONTROL_URL},
        {"id": "original", "url": LEGACY_URL},
        {"id": "other", "url": "/local/user/leapmotor-control.js?v=1"},
    )

    asyncio.run(async_ensure_card_resource(resources, CONTROL_URL))

    resources.async_update_item.assert_awaited_once_with("original", {"url": CONTROL_URL})
    resources.async_delete_item.assert_awaited_once_with("duplicate")
    resources.async_create_item.assert_not_awaited()


def test_existing_static_resource_only_updates_when_version_changes():
    previous = _resources({"id": "card", "url": f"{CARD_URL_STATIC}leapmotor-control.js?v=1"})
    current = _resources({"id": "card", "url": CONTROL_URL})

    asyncio.run(async_ensure_card_resource(previous, CONTROL_URL))
    asyncio.run(async_ensure_card_resource(current, CONTROL_URL))

    previous.async_update_item.assert_awaited_once_with("card", {"url": CONTROL_URL})
    current.async_update_item.assert_not_awaited()
    current.async_create_item.assert_not_awaited()
    current.async_delete_item.assert_not_awaited()


def test_first_install_registers_static_module():
    resources = _resources()

    asyncio.run(async_ensure_card_resource(resources, CONTROL_URL))

    resources.async_create_item.assert_awaited_once_with({"res_type": "module", "url": CONTROL_URL})
