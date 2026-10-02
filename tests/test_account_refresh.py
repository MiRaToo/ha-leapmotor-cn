"""账号 token 免短信续期(``LeapmotorClient.refresh_account_token``)的形状回归测试。

形状来源(2026-09-27 实测, 见 docs/PROTOCOL.md §3):
  * 抓取 App 自己发出的续期请求 —— `com.leapmotor.network.TokenRefreshManager`
  * `signStr` 与抓包**逐字节一致**;refreshToken 走请求头 `XFX-CDN-CROSS-REFRESH-NODE`

这里不发网络:用假 session + 打桩 ``_http``,只钉住"请求长什么样"。
"""
import hashlib
import json
import time
import urllib.parse

import pytest

import api_client


class _FakeResp(dict):
    pass


def _sess(**kw) -> api_client.Session:
    base = dict(
        token="A" * 64,
        refresh_token="B" * 64,
        phone="13800138000",
        user_id="890000000000000001",
        device_id="0123456789abcdef0123456789abcdef",
        version="1.22.98",
    )
    base.update(kw)
    return api_client.Session(**base)


@pytest.fixture()
def captured(monkeypatch):
    """打桩 HTTP, 捕获 (method, url, headers, body)。"""
    box = {}

    def fake_http(self, method, url, headers, body=None, form=False):
        box.update(method=method, url=url, headers=headers, body=body)
        return {"code": 200, "success": True, "msg": "操作成功", "data": {
            "token": "C" * 64,
            "refreshToken": "B" * 64,          # 服务端返回同一个 refreshToken(不轮换)
            "tokenExpired": "21600",
            "accountId": "890000000000000001",
        }}

    monkeypatch.setattr(api_client.LeapmotorClient, "_http", fake_http)
    return box


def test_request_shape(captured):
    s = _sess()
    cli = api_client.LeapmotorClient(s)
    resp = cli.refresh_account_token()

    assert resp["code"] == 200
    assert captured["method"] == "GET"
    assert captured["url"].startswith(
        "https://appuser.leapmotor.cn/app-user/appuseroperate/getnewtoken?")

    q = urllib.parse.parse_qs(urllib.parse.urlsplit(captured["url"]).query)
    for key in ("timespan", "nonce", "deviceID", "accountId", "accountNumber", "signStr"):
        assert key in q, f"缺少参数 {key}"

    assert q["deviceID"][0] == s.device_id           # 必须与登录设备一致
    assert q["accountId"][0] == s.user_id
    assert int(q["timespan"][0]) > 1_700_000_000_000  # 毫秒时间戳
    assert 10000 <= int(q["nonce"][0]) <= 10000000
    # refreshToken 只进签名串, **不**作为 query 参数
    assert s.refresh_token not in captured["url"]

    # 凭据头:refreshToken 走这个头(否则服务端 500)
    assert captured["headers"]["XFX-CDN-CROSS-REFRESH-NODE"] == s.refresh_token


def test_signstr_is_md5_mid16_of_sorted_values(captured):
    s = _sess()
    api_client.LeapmotorClient(s).refresh_account_token()
    q = urllib.parse.parse_qs(urllib.parse.urlsplit(captured["url"]).query)

    src = (q["accountId"][0] + q["accountNumber"][0] + q["deviceID"][0]
           + q["nonce"][0] + s.refresh_token + q["timespan"][0])
    expected = hashlib.md5(src.encode("utf-8")).hexdigest()[8:24]
    assert q["signStr"][0] == expected


def test_account_number_is_rsa_b64url_without_padding(captured):
    api_client.LeapmotorClient(_sess()).refresh_account_token()
    q = urllib.parse.parse_qs(urllib.parse.urlsplit(captured["url"]).query)
    enc = q["accountNumber"][0]
    assert "=" not in enc and "+" not in enc and "/" not in enc
    assert len(enc) == 171          # 128 字节 RSA-1024 密文 → base64url 去 padding


def test_session_updated_on_success(captured):
    s = _sess()
    api_client.LeapmotorClient(s).refresh_account_token()
    assert s.token == "C" * 64
    assert s.refresh_token == "B" * 64              # 不轮换, 原值保留
    assert s.account_token_expires_at > time.time() + 20000


def test_missing_material_raises(captured):
    with pytest.raises(RuntimeError):
        api_client.LeapmotorClient(_sess(refresh_token="")).refresh_account_token()
    with pytest.raises(RuntimeError):
        api_client.LeapmotorClient(_sess(phone="")).refresh_account_token()
    # 允许显式传手机号覆盖
    s = _sess(phone="")
    api_client.LeapmotorClient(s).refresh_account_token(phone="13800138000")
    assert s.token == "C" * 64


def test_session_roundtrip_keeps_phone(tmp_path):
    s = _sess()
    p = tmp_path / "session.json"
    s.save(p)
    back = api_client.Session.load(p)
    assert back.phone == s.phone
    assert json.loads(p.read_text(encoding="utf-8"))["refresh_token"] == s.refresh_token
