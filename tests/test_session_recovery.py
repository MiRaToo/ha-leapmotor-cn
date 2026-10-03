"""会话失效判定 —— 决定集成是"弹重新认证"还是"沿用上一份数据"。

实测背景(2026-09-27): 账号 token 只有约 6 小时有效期, 服务端失效后
车列表返回空 + 错误码, 如果按"没有车辆"处理会把整个设备标成不可用 ——
实际应该让 HA 弹「重新认证」, 用户收一条短信就能恢复。

    python -m pytest tests/test_session_recovery.py -q
"""
import api_client


def test_expired_token_responses_are_auth_errors():
    # 车控/全局服务在 token 失效时给这些码(实测)
    assert api_client.is_auth_error({"code": 302002004, "message": "TOKEN已过期"})
    assert api_client.is_auth_error({"code": 302010202, "message": "第三方TOKEN失效"})
    assert api_client.is_auth_error({"code": 302010219, "message": "登陆过期"})
    assert api_client.is_auth_error({"code": 401})


def test_message_only_variants_are_auth_errors():
    assert api_client.is_auth_error({"code": 1, "message": "登陆过期, 请重新登录"})
    assert api_client.is_auth_error({"data": "token已过期"})


def test_business_errors_are_not_auth_errors():
    # 这些不该触发重新登录: 签名/参数/权限/网络
    assert not api_client.is_auth_error({"code": 302002002, "message": "签名信息校验失败"})
    assert not api_client.is_auth_error({"code": 1, "message": "请求参数为空或不合法！"})
    assert not api_client.is_auth_error({"code": 4, "message": "操作密码错误"})
    assert not api_client.is_auth_error({"code": -1, "message": "网络错误: timeout"})
    assert not api_client.is_auth_error(None)
    assert not api_client.is_auth_error([])
    assert not api_client.is_auth_error({"code": 0, "message": "请求成功"})


def test_success_is_not_mistaken_for_expiry():
    ok = {"code": 0, "data": {"sharedcars": [], "bindcars": []}}
    assert not api_client.is_auth_error(ok)


# ── 签名类错误: 请求没被受理, 但**不等于**会话失效 ──
# 实测(2026-09-27): 车端 JWT 被轮换后, 旧密钥签的请求会被 302010205 拒收;
# 正确处置是"重新交换车端 token 再发一次", 若误判成会话失效就会反复弹重新认证。
def test_signature_errors_are_recognized():
    assert api_client.is_signature_error({"code": 302010205, "message": "签名信息校验失败"})
    assert api_client.is_signature_error({"code": 302002002, "message": "签名信息校验失败"})
    assert api_client.is_signature_error({"code": 39})
    assert api_client.is_signature_error({"code": "302010205"})   # 服务端偶尔给字符串
    assert not api_client.is_signature_error({"code": 0, "message": "请求成功"})
    assert not api_client.is_signature_error({"code": 4, "message": "操作密码错误"})
    assert not api_client.is_signature_error({"code": 302002004, "message": "TOKEN已过期"})
    assert not api_client.is_signature_error(None)


def test_signature_and_auth_error_sets_are_disjoint():
    # 两套判定必须互斥: 同一个码既"要重试"又"要重新认证"会让用户莫名收到重登提示
    assert not (api_client.SIGNATURE_ERROR_CODES & api_client.AUTH_ERROR_CODES)


# ── "车况首拉为空 → 换 token 重试"的触发条件(2026-10-03 连续观测定性) ──
# 真机证据: 每天约 40 次首拉被服务端拒签(302010205), 换一次车端 token 后重试必成功;
# 与 HA 重启无关(09-29 零重启那天也有 59 次)。签名族错误因此是"换 token"的唯一条件;
# 其它原因(网络抖动/未知码)换 token 是白费请求, 还会让别处的会话失效(单账号单会话)。
def test_renew_retry_is_reserved_for_signature_errors():
    # 观测到的实际原因(302010205): 必须换 —— 换完重试必成功
    assert api_client.is_signature_error({"code": 302010205, "message": "签名信息校验失败"})
    # 不该换的典型: 网络异常(code=None)/业务错误/限流(限流另有专门分支处理, 不会走到这)
    assert not api_client.is_signature_error({"code": None})
    assert not api_client.is_signature_error({"code": -1, "message": "网络错误: timeout"})
    assert not api_client.is_signature_error({"code": 4, "message": "操作密码错误"})
    assert not api_client.is_rate_limited({"code": 302010205}), "签名族错误不当限流处理"


def test_coordinator_only_renews_on_signature_error():
    """防回归: 车况重试的换 token 条件必须按签名族判定。

    (旧写法对**任何**空响应/异常都 force 换 token —— 观测显示签名族恰是最常见原因,
    所以它能自愈; 但网络抖动也会连带换 token, 属于白费请求 + 挤掉别处会话。)
    """
    import pathlib
    import re
    src = (pathlib.Path(__file__).resolve().parent.parent / "custom_components"
           / "leapmotor" / "coordinator.py").read_text(encoding="utf-8")
    assert 'is_signature_error({"code": code})' in src, "车况重试必须按签名族错误判定"
    assert "原样重试一次(不换 token)" in src, "非签名错误应原样重试"


# ── 指令是否被受理(决定要不要给用户弹失败提示 + 要不要记乐观状态) ──
def test_command_failed_detection():
    assert api_client.command_failed({"code": 0, "message": "请求成功"}) is None
    assert api_client.command_failed({"code": 200}) is None
    assert api_client.command_failed({}) is None                 # 没有 code 也当成功
    assert api_client.command_failed({"code": 40, "message": "无此权限"}) == "code=40 无此权限"
    assert api_client.command_failed({"code": 4, "message": "操作密码错误"}) == "code=4 操作密码错误"
    assert api_client.command_failed({"code": 70, "message": "密码错误次数过多"}) \
        == "code=70 密码错误次数过多"
    assert "302010205" in api_client.command_failed({"code": 302010205, "message": "签名信息校验失败"})
    assert api_client.command_failed(None) is None


def test_command_failed_and_auth_error_are_consistent():
    # 会话失效本身就是"没受理"的一种 —— 但那边要抛的是"重新认证", 由 _collect 判定
    for code in api_client.AUTH_ERROR_CODES:
        assert api_client.command_failed({"code": code}) is not None
