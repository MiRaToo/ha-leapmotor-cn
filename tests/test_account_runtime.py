"""共享账号认证快照的代次同步与车辆字段隔离。"""
import ast
import importlib
import sys
import types
from pathlib import Path
from types import SimpleNamespace


package = types.ModuleType("_account_runtime_test")
package.__path__ = [str(Path(__file__).resolve().parents[1] / "custom_components" / "leapmotor")]
const = types.ModuleType("_account_runtime_test.const")
const.DOMAIN = "leapmotor"
sys.modules[package.__name__] = package
sys.modules[const.__name__] = const
mod = importlib.import_module("_account_runtime_test.account_runtime")


class ConfigEntries:
    def __init__(self, entries):
        self.entries = entries

    def async_entries(self, _domain):
        return self.entries

    def async_update_entry(self, entry, *, data):
        entry.data = data


class ImmediateLock:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False


def run_immediate(coro):
    """Drive these stubbed coroutines without creating a Windows event loop."""
    try:
        coro.send(None)
    except StopIteration as result:
        return result.value
    raise AssertionError("test coroutine unexpectedly suspended")


class Hass:
    def __init__(self, entries):
        self.data = {}
        self.config_entries = ConfigEntries(entries)

    async def async_add_executor_job(self, func):
        return func()


def make_entry(entry_id, vin):
    return SimpleNamespace(entry_id=entry_id, data={
        "phone": "+8613800000000", "device_id": "same-login-device",
        "token": "old", "refresh_token": "refresh", "car_token": "old-car",
        "car_refresh_token": "car-refresh", "sign_param": {"r2": "r"},
        "encrypt_param": {"r2": "e"}, "hkdf_key_hex": "old-key",
        "user_id": "account", "account_id": "account", "account_token_expires_at": 100,
        "version": "1.0", "sub_version": "1.0",
        "vin": vin, "car_vin": vin, "car_type": "C10",
        "car_nickname": "车" + vin, "reev": vin.endswith("B"),
        "operate_pwd": "pin-" + vin, "operate_pwd_mode": "plain",
        "options_marker": "keep-" + vin,
    })


class Coordinator:
    def __init__(self, hass, entry):
        self.hass = hass
        self.entry = entry
        self.vin = entry.data["vin"]
        self.vehicle = SimpleNamespace(car_type=entry.data["car_type"])
        self.session = SimpleNamespace(**{name: entry.data.get(name, "") for name in mod.AUTH_FIELDS})
        self.session.seal_key = lambda: None
        self.client = SimpleNamespace(session=self.session)
        self.state = None
        self._last_renew = 0
        self._auth_revision = 0
        self._rate_limited_until = 0
        self.renew_calls = [0]

    def _renew_if_needed(self, *, force=False):
        self.renew_calls[0] += 1
        self.session.token = "new-token"
        self.session.car_token = "new-car-token"
        self.session.hkdf_key_hex = "new-key"
        self._last_renew = 200
        return True


def test_account_refresh_is_shared_and_persisted_without_merging_vehicle_fields():
    a, b = make_entry("a", "VIN-A"), make_entry("b", "VIN-B")
    hass = Hass([a, b])
    ca, cb = Coordinator(hass, a), Coordinator(hass, b)
    context = mod.attach(ca)
    mod.attach(cb)
    context.lock = ImmediateLock()
    old_session = ca.session
    old_client = ca.client

    # The first request advances the generation while holding the shared lock;
    # a sibling that failed using generation 0 then reuses generation 1.
    assert run_immediate(mod.async_renew(ca, force=True, observed_revision=0)) is True
    assert run_immediate(mod.async_renew(cb, force=True, observed_revision=0)) is True
    assert ca.renew_calls[0] + cb.renew_calls[0] == 1
    assert ca.session is not old_session
    assert old_session.token == "old"
    assert ca.client is not old_client
    assert old_client.session is old_session
    assert ca.client.session is ca.session
    assert ca.session.token == cb.session.token == "new-token"
    for entry, vin in ((a, "VIN-A"), (b, "VIN-B")):
        assert entry.data["token"] == "new-token"
        assert entry.data["car_token"] == "new-car-token"
        assert entry.data["vin"] == entry.data["car_vin"] == vin
        assert entry.data["car_nickname"] == "车" + vin
        assert entry.data["operate_pwd"] == "pin-" + vin
        assert entry.data["options_marker"] == "keep-" + vin
        assert entry.data["reev"] is vin.endswith("B")
        assert entry.data[mod.AUTH_GENERATION_FIELD] == 1


def test_late_coordinator_starts_from_latest_complete_auth_generation():
    a = make_entry("a", "VIN-A")
    hass = Hass([a])
    first = Coordinator(hass, a)
    context = mod.attach(first)
    first.session.token = "latest-token"
    first.session.car_token = "latest-car-token"
    context.rate_limited_until = 500
    mod._publish_snapshot(context, first)

    late_entry = make_entry("late", "VIN-B")
    late = Coordinator(hass, late_entry)
    mod.attach(late)
    assert late.session.token == "latest-token"
    assert late.session.car_token == "latest-car-token"
    assert late._auth_revision == context.revision
    assert late._rate_limited_until == 500


def test_notification_identity_separates_login_devices_for_the_same_phone():
    data = make_entry("a", "VIN-A").data
    other_device = {**data, "device_id": "other-login-device"}
    assert mod.notification_id(data) != mod.notification_id(other_device)
    assert mod.notification_id(data) == mod.notification_id({**data, "vin": "VIN-B"})


def test_coordinator_initializes_home_assistant_before_account_attach():
    source = Path(__file__).resolve().parents[1] / "custom_components" / "leapmotor" / "coordinator.py"
    tree = ast.parse(source.read_text(encoding="utf-8"))
    coordinator = next(node for node in tree.body
                       if isinstance(node, ast.ClassDef) and node.name == "LeapmotorCoordinator")
    initializer = next(node for node in coordinator.body
                       if isinstance(node, ast.FunctionDef) and node.name == "__init__")
    super_init = next(node for node in ast.walk(initializer)
                      if isinstance(node, ast.Call)
                      and isinstance(node.func, ast.Attribute)
                      and node.func.attr == "__init__"
                      and isinstance(node.func.value, ast.Call)
                      and isinstance(node.func.value.func, ast.Name)
                      and node.func.value.func.id == "super")
    attach = next(node for node in ast.walk(initializer)
                  if isinstance(node, ast.Call)
                  and isinstance(node.func, ast.Name)
                  and node.func.id == "attach")
    assert super_init.lineno < attach.lineno, (
        "DataUpdateCoordinator must set self.hass before attach() accesses it"
    )
