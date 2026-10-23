"""Resolve a card or WebSocket request to exactly one configured vehicle."""

from __future__ import annotations

from typing import Any

from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er

from .const import DOMAIN


class VehicleSelectionError(ValueError):
    """The request does not identify one unambiguous vehicle."""


def coordinators(hass: Any) -> dict[str, Any]:
    return {
        str(entry_id): coordinator
        for entry_id, coordinator in (hass.data.get(DOMAIN) or {}).items()
        if getattr(coordinator, "entry", None) is not None
        and getattr(coordinator, "vin", None)
    }


def selection_error(hass: Any, msg: dict[str, Any]) -> str:
    if not any(msg.get(key) for key in ("entry_id", "vin", "device_id", "entity_id")):
        if len(hass.config_entries.async_entries(DOMAIN)) > 1:
            return "vehicle_required"
    return "vehicle_unavailable"


def resolve_coordinator(hass: Any, msg: dict[str, Any]) -> Any:
    """Resolve and cross-check every supplied vehicle selector."""
    loaded = coordinators(hass)
    entries = {entry.entry_id: entry for entry in hass.config_entries.async_entries(DOMAIN)}
    candidates = set(entries)
    specified = False
    selector_matches: list[set[str]] = []

    entry_id = str(msg.get("entry_id") or "")
    if entry_id:
        specified = True
        matches = {entry_id} if entry_id in entries else set()
        selector_matches.append(matches)
        candidates.intersection_update(matches)

    vin = str(msg.get("vin") or "").strip()
    if vin:
        specified = True
        matches = {key for key, entry in entries.items()
                   if str(entry.data.get("vin") or entry.data.get("car_vin") or "").upper()
                   == vin.upper()}
        selector_matches.append(matches)
        candidates.intersection_update(matches)

    device_id = str(msg.get("device_id") or "")
    if device_id:
        specified = True
        device = dr.async_get(hass).async_get(device_id)
        device_vins = {
            str(identifier) for domain, identifier in (device.identifiers if device else set())
            if domain == DOMAIN
        }
        matches = {key for key, entry in entries.items()
                   if str(entry.data.get("vin") or entry.data.get("car_vin") or "") in device_vins}
        selector_matches.append(matches)
        candidates.intersection_update(matches)

    entity_id = str(msg.get("entity_id") or "")
    if entity_id:
        specified = True
        entity = er.async_get(hass).async_get(entity_id)
        if entity is None or entity.platform != DOMAIN:
            matches = set()
        else:
            entry_key = str(entity.config_entry_id)
            matches = {entry_key} if entry_key in entries else set()
        selector_matches.append(matches)
        candidates.intersection_update(matches)

    if not specified:
        # Count configured entries too, so an unloaded/disabled second vehicle
        # cannot silently make the remaining loaded car the default.
        if len(entries) != 1:
            raise VehicleSelectionError("vehicle_required" if entries else "vehicle_unavailable")
        candidates.intersection_update(set(entries))

    if len(candidates) != 1:
        reason = "vehicle_unavailable"
        if specified and len(selector_matches) > 1 and all(selector_matches) and not candidates:
            reason = "vehicle_conflict"
        elif not specified and len(entries) > 1:
            reason = "vehicle_required"
        raise VehicleSelectionError(reason)

    key = next(iter(candidates))
    coordinator = loaded.get(key)
    if coordinator is None:
        raise VehicleSelectionError("vehicle_unavailable")
    return coordinator
