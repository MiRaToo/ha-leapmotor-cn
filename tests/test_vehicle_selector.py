"""多车 WebSocket 目标解析：配置条目数量优先于已加载条目。"""
import importlib
import sys
import types
from pathlib import Path
from types import SimpleNamespace


def _load_module():
    if "homeassistant" not in sys.modules:
        ha = types.ModuleType("homeassistant")
        ha.__path__ = []
        helpers = types.ModuleType("homeassistant.helpers")
        helpers.__path__ = []
        device_registry = types.ModuleType("homeassistant.helpers.device_registry")
        entity_registry = types.ModuleType("homeassistant.helpers.entity_registry")
        device_registry.async_get = lambda hass: hass.device_registry
        entity_registry.async_get = lambda hass: hass.entity_registry
        sys.modules.update({
            "homeassistant": ha,
            "homeassistant.helpers": helpers,
            "homeassistant.helpers.device_registry": device_registry,
            "homeassistant.helpers.entity_registry": entity_registry,
        })
    package = types.ModuleType("_vehicle_selector_test")
    package.__path__ = [str(Path(__file__).resolve().parents[1] / "custom_components" / "leapmotor")]
    const = types.ModuleType("_vehicle_selector_test.const")
    const.DOMAIN = "leapmotor"
    sys.modules[package.__name__] = package
    sys.modules[const.__name__] = const
    return importlib.import_module("_vehicle_selector_test.vehicle_selector")


mod = _load_module()


class Registry:
    def __init__(self, items=()):
        self.items = list(items)
        self.entities = {getattr(item, "entity_id", getattr(item, "id", "")): item for item in self.items}

    def async_get(self, key):
        return self.entities.get(key)

    def async_get_device(self, identifiers):
        return next((item for item in self.items if item.identifiers & identifiers), None)


class Entries:
    def __init__(self, entries):
        self.entries = entries

    def async_entries(self, _domain):
        return self.entries


def setup(entries, loaded_ids=None):
    loaded_ids = set(loaded_ids if loaded_ids is not None else [entry.entry_id for entry in entries])
    coordinators = {
        entry.entry_id: SimpleNamespace(entry=entry, vin=entry.data["vin"])
        for entry in entries if entry.entry_id in loaded_ids
    }
    hass = SimpleNamespace(
        data={"leapmotor": coordinators}, config_entries=Entries(entries),
        device_registry=Registry(), entity_registry=Registry(),
    )
    return hass, coordinators


def entry(entry_id, vin):
    return SimpleNamespace(entry_id=entry_id, data={"vin": vin})


def test_implicit_selection_keeps_single_vehicle_compatibility():
    only = entry("a", "VIN-A")
    hass, coordinators = setup([only])
    assert mod.resolve_coordinator(hass, {}) is coordinators["a"]


def test_unloaded_second_vehicle_still_requires_explicit_selection():
    a, b = entry("a", "VIN-A"), entry("b", "VIN-B")
    hass, _ = setup([a, b], loaded_ids=["a"])
    try:
        mod.resolve_coordinator(hass, {})
    except mod.VehicleSelectionError as err:
        assert str(err) == "vehicle_required"
    else:
        raise AssertionError("one loaded coordinator must not become a silent default")


def test_all_supplied_selectors_must_identify_the_same_vehicle():
    a, b = entry("a", "VIN-A"), entry("b", "VIN-B")
    hass, _ = setup([a, b])
    try:
        mod.resolve_coordinator(hass, {"entry_id": "a", "vin": "VIN-B"})
    except mod.VehicleSelectionError as err:
        assert str(err) == "vehicle_conflict"
    else:
        raise AssertionError("conflicting VIN and entry id must be rejected")


def test_device_and_entity_registry_select_the_configured_vin():
    a, b = entry("a", "VIN-A"), entry("b", "VIN-B")
    hass, coordinators = setup([a, b])
    hass.device_registry = Registry([SimpleNamespace(id="dev-b", identifiers={("leapmotor", "VIN-B")})])
    hass.entity_registry = Registry([SimpleNamespace(
        entity_id="sensor.vehicle_b_battery", platform="leapmotor", config_entry_id="b",
    )])
    assert mod.resolve_coordinator(hass, {"device_id": "dev-b"}) is coordinators["b"]
    assert mod.resolve_coordinator(hass, {"entity_id": "sensor.vehicle_b_battery"}) is coordinators["b"]


def test_explicit_but_unloaded_target_does_not_fall_back():
    a, b = entry("a", "VIN-A"), entry("b", "VIN-B")
    hass, _ = setup([a, b], loaded_ids=["a"])
    try:
        mod.resolve_coordinator(hass, {"vin": "VIN-B"})
    except mod.VehicleSelectionError as err:
        assert str(err) == "vehicle_unavailable"
    else:
        raise AssertionError("an explicit unavailable VIN must not resolve to another car")
