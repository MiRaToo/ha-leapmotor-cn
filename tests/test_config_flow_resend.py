"""验证码超时后「重新发送验证码」的配置流程回归测试。

背景: HA 的配置表单只有一个提交按钮, 而且会在前端拦下空的必填字段
(`ui.panel.config.integrations.config_flow.not_all_required_fields`) —— 旧的
「必填验证码 + 重新发送勾选框」在验证码超时后根本提交不出去, 请求到不了后端。

所以这里钉住三件事:
  1. `sms_code` 必须是**可选**字段(空表单能过 schema);
  2. 留空提交 / 服务端说过期(100116) → 进入**单独的重发菜单**(按钮);
  3. 重发成功后回到验证码表单, 失败按错误类型回到表单显示错误。
"""

from __future__ import annotations

import asyncio
import importlib
import json
import sys
import types
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
PKG = "_leapmotor_config_flow_test"
RESEND_MENU = {"resend", "code"}


# ── 替身: CI 只装 pytest, 这里补上 config_flow 需要的 HA / voluptuous 表面 ──
class _ConfigFlow:
    domain = None

    def __init_subclass__(cls, domain=None, **kwargs):
        super().__init_subclass__(**kwargs)
        if domain is not None:
            cls.domain = domain

    def __init__(self):
        self.hass = None
        self.context = {}
        self.flow_id = "test-flow"
        self.handler = "leapmotor"
        self.source = "user"

    def async_show_form(self, *, step_id, data_schema=None, errors=None,
                        description_placeholders=None, last_step=None, preview=None):
        return {"type": "form", "step_id": step_id, "data_schema": data_schema,
                "errors": errors or {},
                "description_placeholders": description_placeholders or {}}

    def async_show_menu(self, *, step_id, menu_options, description_placeholders=None):
        return {"type": "menu", "step_id": step_id, "menu_options": list(menu_options),
                "description_placeholders": description_placeholders or {}}

    def async_abort(self, **kwargs):
        return {"type": "abort", **kwargs}

    def async_create_entry(self, **kwargs):
        return {"type": "create_entry", **kwargs}


def _install_voluptuous() -> types.ModuleType:
    """有真 voluptuous 就用真的, 没有就装一个最小的替身(只覆盖用到的三种对象)。"""
    try:
        return importlib.import_module("voluptuous")
    except ImportError:
        pass

    vol = types.ModuleType("voluptuous")

    class _Marker:
        def __init__(self, schema, default=...):
            self.schema = schema
            self.default = default

    class Optional(_Marker):
        pass

    class Required(_Marker):
        pass

    class Schema:
        def __init__(self, schema):
            self.schema = dict(schema)

        def __call__(self, data):
            out = {}
            for marker, _validator in self.schema.items():
                name = marker.schema if isinstance(marker, _Marker) else marker
                if name in data and data[name] != "":
                    out[name] = data[name]
                elif isinstance(marker, Required):
                    raise ValueError(f"required key not provided: {name}")
                elif getattr(marker, "default", ...) is not ...:
                    out[name] = marker.default
            return out

    vol.Optional, vol.Required, vol.Schema = Optional, Required, Schema
    sys.modules["voluptuous"] = vol
    return vol


def _install_homeassistant() -> None:
    class _Selector:
        def __init__(self, *args, **kwargs):
            pass

    class _Mode:
        DROPDOWN = "dropdown"
        BOX = "box"
        PASSWORD = "password"

    selector = types.ModuleType("homeassistant.helpers.selector")
    selector.__getattr__ = lambda _name: _Selector
    selector.SelectSelectorMode = _Mode
    selector.NumberSelectorMode = _Mode
    selector.TextSelectorType = _Mode

    config_entries = types.ModuleType("homeassistant.config_entries")
    config_entries.ConfigFlow = _ConfigFlow
    config_entries.OptionsFlow = _Selector
    config_entries.ConfigEntry = object
    config_entries.ConfigFlowResult = dict

    core = types.ModuleType("homeassistant.core")
    core.HomeAssistant = object

    helpers = types.ModuleType("homeassistant.helpers")
    helpers.selector = selector
    homeassistant = types.ModuleType("homeassistant")
    homeassistant.config_entries = config_entries
    homeassistant.core = core
    homeassistant.helpers = helpers

    for name, module in {
        "homeassistant": homeassistant,
        "homeassistant.config_entries": config_entries,
        "homeassistant.core": core,
        "homeassistant.helpers": helpers,
        "homeassistant.helpers.selector": selector,
    }.items():
        sys.modules[name] = module


class FakeHass:
    def __init__(self):
        self.data = {}
        self.config_entries = SimpleNamespace(
            async_entries=lambda _domain: [],
            async_update_entry=lambda *_args, **_kwargs: None,
        )

    async def async_add_executor_job(self, func, *args):
        return func(*args)


class FakeClient:
    """只实现配置流程用到的方法; 响应由各测试改类属性。"""

    sms_response = {"code": 200}
    login_response = {"code": 200}
    car_login_response = {"code": 200}

    def __init__(self, session):
        self.session = session
        self.sms_calls = 0

    def request_sms_code(self, _phone):
        self.sms_calls += 1
        return dict(FakeClient.sms_response)

    def login(self, _phone, _code):
        response = dict(FakeClient.login_response)
        if response.get("code") == 200:
            self.session.token = "account-token"
            self.session.refresh_token = "refresh-token"
        return response

    def car_login(self):
        self.session.car_token = "car-token"
        self.session.sign_param = {"r2": "r2", "r3": "r3"}
        self.session.hkdf_key_hex = "00" * 32  # 跳过真实密钥派生
        return dict(FakeClient.car_login_response)

    def get_vehicle_list(self):
        return []


@pytest.fixture(scope="module")
def flow():
    saved = dict(sys.modules)
    vol = _install_voluptuous()
    _install_homeassistant()
    package = types.ModuleType(PKG)
    package.__path__ = [str(ROOT / "custom_components" / "leapmotor")]
    sys.modules[PKG] = package
    try:
        module = importlib.import_module(f"{PKG}.config_flow")
        yield SimpleNamespace(mod=module, vol=vol)
    finally:
        for name in [name for name in sys.modules if name not in saved]:
            del sys.modules[name]
        sys.modules.update(saved)


@pytest.fixture
def client(flow, monkeypatch):
    monkeypatch.setattr(flow.mod, "LeapmotorClient", FakeClient)
    FakeClient.sms_response = {"code": 200}
    FakeClient.login_response = {"code": 200}
    return FakeClient


def _run(coro):
    return asyncio.run(coro)


def _flow(flow) -> object:
    instance = flow.mod.LeapmotorConfigFlow()
    instance.hass = FakeHass()
    instance._phone = "+8613800000000"
    instance._session = {"device_id": "device-1"}
    return instance


def _fields(schema) -> dict:
    return {getattr(key, "schema", key): key for key in schema.schema}


# ── 表单本身: 验证码可选, 旧勾选框已移除 ──
def test_sms_code_is_optional_so_empty_form_can_submit(flow, client):
    result = _run(_flow(flow).async_step_code())

    assert result["type"] == "form"
    assert result["step_id"] == "code"
    fields = _fields(result["data_schema"])
    assert set(fields) == {"sms_code"}
    assert isinstance(fields["sms_code"], flow.vol.Optional), "必填会把重发堵在前端校验里"
    # 前端对空字段只发非空值, 空 dict 必须能通过 schema
    assert result["data_schema"]({}) == {}
    assert result["data_schema"]({"sms_code": "123456"}) == {"sms_code": "123456"}


# ── 超时/留空 → 单独的重发菜单 ──
@pytest.mark.parametrize("user_input", [{}, {"sms_code": ""}, {"sms_code": "   "}])
def test_submitting_without_code_opens_resend_menu(flow, client, user_input):
    result = _run(_flow(flow).async_step_code(user_input))

    assert result["type"] == "menu"
    assert result["step_id"] == "code_resend"
    assert set(result["menu_options"]) == RESEND_MENU


def test_expired_code_opens_resend_menu(flow, client):
    client.login_response = {"code": 100116}
    result = _run(_flow(flow).async_step_code({"sms_code": "123456"}))

    assert result["type"] == "menu"
    assert result["step_id"] == "code_resend"


def test_wrong_code_stays_on_form_with_error(flow, client):
    client.login_response = {"code": 100115}
    result = _run(_flow(flow).async_step_code({"sms_code": "123456"}))

    assert result["type"] == "form"
    assert result["step_id"] == "code"
    assert result["errors"] == {"base": "invalid_auth"}


# ── 菜单里的重发按钮: 不需要任何输入, 成功回到验证码表单 ──
def test_resend_needs_no_input_and_returns_to_code_form(flow, client):
    instance = _flow(flow)
    menu = _run(instance.async_step_code({}))
    assert menu["type"] == "menu"

    result = _run(instance.async_step_resend())

    assert result["type"] == "form"
    assert result["step_id"] == "code_resent"
    assert isinstance(_fields(result["data_schema"])["sms_code"], flow.vol.Optional)


@pytest.mark.parametrize("code, error", [(36, "sms_too_often"), (1023, "risk_cooldown")])
def test_resend_failure_reports_error_on_form(flow, client, code, error):
    client.sms_response = {"code": code}
    result = _run(_flow(flow).async_step_resend())

    assert result["type"] == "form"
    assert result["errors"] == {"base": error}


def test_resent_form_submit_delegates_to_normal_code_check(flow, client):
    result = _run(_flow(flow).async_step_code_resent({}))

    assert result["type"] == "menu"
    assert result["step_id"] == "code_resend"


def test_valid_code_still_runs_login_and_vehicle_lookup(flow, client):
    result = _run(_flow(flow).async_step_code({"sms_code": "123456"}))

    assert result["type"] == "form"
    assert result["errors"] == {"base": "no_vehicle"}  # 假账号名下没有车


# ── 翻译契约: 三种语言都要有菜单文案, 且不再有 resend 字段 ──
@pytest.mark.parametrize("name", ["strings.json",
                                  "translations/zh-Hans.json",
                                  "translations/en.json"])
def test_translation_files_match_new_flow(flow, name):
    data = json.loads((ROOT / "custom_components" / "leapmotor" / name)
                      .read_text(encoding="utf-8"))
    step = data["config"]["step"]

    assert set(step["code"]["data"]) == {"sms_code"}, "旧「重新发送」勾选框必须移除"
    assert step["code_resend"]["title"].strip()
    assert set(step["code_resend"]["menu_options"]) == RESEND_MENU
    assert step["code_resend"]["description"].strip()
    assert set(step["code_resent"]["data"]) == {"sms_code"}
    assert step["code_resent"]["description"].strip()
    assert "勾选" not in step["code"]["description"]
