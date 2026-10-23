"""同一登录设备的账号会话共享与续期互斥。"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import logging
import re
import time
from dataclasses import asdict, dataclass, field
from functools import partial
from typing import Any
from weakref import WeakSet

from .const import DOMAIN

log = logging.getLogger(__name__)
STORE_KEY = f"{DOMAIN}_accounts"

# 这些字段属于登录/车端交换会话。PIN、车型、VIN 和其他车辆元数据不在其中。
AUTH_FIELDS = (
    "token", "refresh_token", "phone", "car_token", "car_refresh_token",
    "sign_param", "encrypt_param", "hkdf_key_hex", "account_id", "user_id", "device_id",
    "account_token_expires_at", "version", "sub_version",
)
AUTH_GENERATION_FIELD = "_auth_generation"


def account_key(phone: Any) -> str:
    """为同一中国手机号生成稳定的内存索引，不以共享车主 ID 识别登录账号。"""
    raw = str(phone or "").strip()
    digits = "".join(re.findall(r"\d", raw))
    if raw.startswith("+86") and len(digits) == 13 and digits.startswith("86"):
        digits = digits[2:]
    elif raw.startswith("0086") and len(digits) == 15 and digits.startswith("0086"):
        digits = digits[4:]
    return digits or raw.casefold()


def context_key(data: dict[str, Any], fallback: str = "") -> tuple[str, str]:
    phone = account_key(data.get("phone"))
    device = str(data.get("device_id") or "")
    if not phone:
        phone = f"entry:{fallback}"
    return phone, device


def notification_id(data: dict[str, Any], fallback: str = "") -> str:
    identity = context_key(data, fallback)
    digest = hashlib.sha256("\0".join(identity).encode("utf-8")).hexdigest()[:12]
    return f"{DOMAIN}_session_expired_{digest}"


@dataclass
class AuthContext:
    key: tuple[str, str]
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    snapshot: dict[str, Any] = field(default_factory=dict)
    revision: int = 0
    last_renew: float = 0.0
    rate_limited_until: float = 0.0
    coordinators: WeakSet[Any] = field(default_factory=WeakSet)


def _contexts(hass: Any) -> dict[tuple[str, str], AuthContext]:
    return hass.data.setdefault(STORE_KEY, {})


def _entry_generation(entry: Any) -> int:
    try:
        return max(0, int(entry.data.get(AUTH_GENERATION_FIELD, 0)))
    except (TypeError, ValueError):
        return 0


def _replace_session(coordinator: Any, snapshot: dict[str, Any]) -> None:
    """Atomically install one complete auth generation while preserving car fields."""
    current = coordinator.session
    try:
        values = asdict(current)
    except TypeError:
        values = vars(copy.copy(current))
    values.update(snapshot)
    if hasattr(current, "__dataclass_fields__"):
        values = {name: values[name] for name in current.__dataclass_fields__ if name in values}
        session = type(current)(**values)
    else:
        session = copy.copy(current)
        for name, value in snapshot.items():
            setattr(session, name, value)
    session.seal_key()
    coordinator.session = session
    client = getattr(coordinator, "client", None)
    if client is not None:
        client = copy.copy(client)
        client.session = session
        coordinator.client = client


def _run_auth_operation(coordinator: Any, method_name: str,
                        **kwargs: Any) -> tuple[bool, Any, float, Any, Any]:
    """Renew on a private session so in-flight API calls keep a consistent snapshot."""
    worker = copy.copy(coordinator)
    try:
        session = type(coordinator.session)(**asdict(coordinator.session))
    except TypeError:
        session = copy.copy(coordinator.session)
    client = copy.copy(coordinator.client)
    client.session = session
    worker.session = session
    worker.client = client
    changed = bool(getattr(worker, method_name)(**kwargs))
    return changed, worker.session, worker._last_renew, worker.state, worker.client


def _adopt_auth_operation(coordinator: Any, result: tuple[bool, Any, float, Any, Any]) -> bool:
    changed, session, last_renew, state, client = result
    if not changed:
        return False
    coordinator.session = session
    coordinator.client = client
    coordinator.client.session = session
    coordinator._last_renew = last_renew
    coordinator.state = state
    return True


def attach(coordinator: Any) -> AuthContext:
    key = context_key(coordinator.entry.data, coordinator.entry.entry_id)
    contexts = _contexts(coordinator.hass)
    context = contexts.get(key)
    stored_generation = _entry_generation(coordinator.entry)
    if context is None:
        context = AuthContext(key=key, revision=stored_generation)
        contexts[key] = context
    context.coordinators.add(coordinator)
    if not context.snapshot:
        context.snapshot = {name: getattr(coordinator.session, name)
                            for name in AUTH_FIELDS}
    elif stored_generation > context.revision:
        # A later complete snapshot survived restart in another vehicle entry.
        context.snapshot = {name: getattr(coordinator.session, name)
                            for name in AUTH_FIELDS}
        context.revision = stored_generation
        context.last_renew = getattr(coordinator, "_last_renew", 0.0)
        for peer in tuple(context.coordinators):
            if peer is not coordinator:
                _replace_session(peer, context.snapshot)
                peer._auth_revision = context.revision
    elif context.revision:
        # A sibling entry may be set up after another one already renewed the
        # shared session. Seed it from that complete generation before its first
        # poll; otherwise it could overwrite the newer credentials with stale data.
        _replace_session(coordinator, context.snapshot)
        coordinator._last_renew = context.last_renew
    coordinator._auth_context = context
    coordinator._auth_revision = context.revision
    coordinator._rate_limited_until = max(
        getattr(coordinator, "_rate_limited_until", 0.0), context.rate_limited_until)
    return context


def detach(coordinator: Any) -> None:
    context = getattr(coordinator, "_auth_context", None)
    if context is None:
        return
    context.coordinators.discard(coordinator)
    if not context.coordinators:
        _contexts(coordinator.hass).pop(context.key, None)


def _apply_snapshot(coordinator: Any, context: AuthContext) -> None:
    if coordinator._auth_revision >= context.revision:
        return
    _replace_session(coordinator, context.snapshot)
    coordinator._auth_revision = context.revision
    coordinator._last_renew = context.last_renew


def _publish_snapshot(context: AuthContext, source: Any) -> None:
    context.snapshot = {name: getattr(source.session, name) for name in AUTH_FIELDS}
    context.revision += 1
    context.last_renew = source._last_renew
    for peer in tuple(context.coordinators):
        if peer is source:
            peer._auth_revision = context.revision
            continue
        _replace_session(peer, context.snapshot)
        peer._auth_revision = context.revision
        peer._last_renew = context.last_renew


def _persist_context(context: AuthContext) -> None:
    """将完整认证代次写回各车条目，同时保留每车自己的配置字段。"""
    owner = next(iter(context.coordinators), None)
    if owner is None:
        return
    persisted: set[str] = set()
    for coordinator in tuple(context.coordinators):
        data = dict(coordinator.entry.data)
        data.update(context.snapshot)
        data[AUTH_GENERATION_FIELD] = context.revision
        data["vin"] = coordinator.vin
        data["car_vin"] = coordinator.vin
        if coordinator.vehicle and coordinator.vehicle.car_type:
            data["car_type"] = coordinator.vehicle.car_type
        coordinator.hass.config_entries.async_update_entry(
            coordinator.entry, data=data)
        persisted.add(coordinator.entry.entry_id)
    # Also refresh entries which are disabled or currently unloaded. Their own VIN,
    # options and other per-car fields remain untouched.
    for entry in owner.hass.config_entries.async_entries(DOMAIN):
        if entry.entry_id in persisted or context_key(entry.data, entry.entry_id) != context.key:
            continue
        data = dict(entry.data)
        data.update(context.snapshot)
        data[AUTH_GENERATION_FIELD] = context.revision
        data["vin"] = entry.data.get("vin") or data.get("car_vin", "")
        data["car_vin"] = entry.data.get("vin") or data.get("car_vin", "")
        owner.hass.config_entries.async_update_entry(entry, data=data)


async def async_renew(coordinator: Any, *, force: bool = False,
                      observed_revision: int | None = None) -> bool:
    """互斥地执行一次续期；成功后把完整的新代次传播到同会话的车辆。"""
    context = getattr(coordinator, "_auth_context", None) or attach(coordinator)
    async with context.lock:
        if observed_revision is not None and context.revision > observed_revision:
            _apply_snapshot(coordinator, context)
            return True
        _apply_snapshot(coordinator, context)
        result = await coordinator.hass.async_add_executor_job(
            partial(_run_auth_operation, coordinator, "_renew_if_needed", force=force))
        changed = _adopt_auth_operation(coordinator, result)
        if changed:
            _publish_snapshot(context, coordinator)
            _persist_context(context)
        return bool(changed)


async def async_refresh_account(coordinator: Any, *, force: bool = False,
                                observed_revision: int | None = None) -> bool:
    """共用账号 token 续期，防止多辆车并发发送相同的刷新请求。"""
    context = getattr(coordinator, "_auth_context", None) or attach(coordinator)
    async with context.lock:
        if observed_revision is not None and context.revision > observed_revision:
            _apply_snapshot(coordinator, context)
            return True
        _apply_snapshot(coordinator, context)
        result = await coordinator.hass.async_add_executor_job(
            partial(_run_auth_operation, coordinator, "_account_refresh_if_needed", force=force))
        changed = _adopt_auth_operation(coordinator, result)
        if changed:
            _publish_snapshot(context, coordinator)
            _persist_context(context)
        return bool(changed)


def sync_new_auth(hass: Any, data: dict[str, Any], *, excluded_entry_id: str = "") -> int:
    """在重新认证后，把新会话保存给相同手机号和 device_id 的车辆。"""
    key = context_key(data)
    context = _contexts(hass).get(key)
    snapshot = {name: data[name] for name in AUTH_FIELDS if name in data}
    if not snapshot:
        try:
            return max(0, int(data.get(AUTH_GENERATION_FIELD, 0)))
        except (TypeError, ValueError):
            return 0
    entries = hass.config_entries.async_entries(DOMAIN)
    peers = [entry for entry in entries
             if context_key(entry.data, entry.entry_id) == key]
    if context is not None:
        context.snapshot = {**context.snapshot, **snapshot}
        context.revision += 1
        context.last_renew = time.time()
        for coordinator in tuple(context.coordinators):
            _replace_session(coordinator, context.snapshot)
            coordinator._auth_revision = context.revision
            coordinator._last_renew = context.last_renew
        snapshot = context.snapshot
        generation = context.revision
    else:
        generation = max((_entry_generation(entry) for entry in peers), default=0) + 1
    for entry in entries:
        if entry.entry_id == excluded_entry_id:
            continue
        if context_key(entry.data, entry.entry_id) != key:
            continue
        updated = dict(entry.data)
        updated.update(snapshot)
        updated[AUTH_GENERATION_FIELD] = generation
        hass.config_entries.async_update_entry(entry, data=updated)
    return generation
