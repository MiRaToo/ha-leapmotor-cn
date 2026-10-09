"""指令 payload 形状的回归测试 —— 对照 EU 版在真车上验证过的表。

为什么需要
----------
"云端受理(code 0)但车不执行" 这类问题非常难发现: 接口不报错、日志也正常,
只有站在车边看才知道没动。实测踩过一次: 车窗开发 `{"value":"100"}` 车不动,
而 EU 验证表里是 `{"value":"2"}`。这个测试把**已验证的形状**钉死, 防止再改错。

    python -m pytest tests/test_command_payloads.py -q
"""
import api_client


def _capture():
    """把 remote_control 换成记录器, 返回记录列表。"""
    cli = api_client.LeapmotorClient(api_client.Session(car_vin="VIN"))
    calls: list[tuple] = []
    cli.remote_control = lambda vin, cmd, state=None, extra=None: (   # type: ignore[assignment]
        calls.append((cmd, state)) or {"code": 0}
    )
    return cli, calls


def test_verified_payloads_match_the_eu_table():
    cli, calls = _capture()
    cli.lock()
    cli.unlock()
    cli.find_car()
    cli.open_trunk()
    cli.close_trunk()
    cli.windows_open()            # 全开 = "10"(0~10 刻度)
    cli.windows_vent()            # 微开 = "2"
    cli.windows_half()            # 半开 = "5"
    cli.windows_close()           # 关  = "0"
    cli.sunshade_open()
    cli.sunshade_close()
    cli.preheat_on()
    cli.preheat_off()
    cli.steering_heat(on=True)
    cli.steering_heat(on=False)
    cli.mirror_heat(on=True)
    cli.mirror_heat(on=False)
    cli.set_seat(position="driver", level=2, heat=True)
    cli.set_seat(position="copilot", level=1, heat=False)

    assert calls == [
        (110, {"value": "lock"}),
        (110, {"value": "unlock"}),
        (120, {"value": "true"}),
        (130, {"value": "true"}),
        (130, {"value": "false"}),
        (230, {"value": "10"}),       # 全开
        (230, {"value": "2"}),        # 微开(≈20%)
        (230, {"value": "5"}),        # 半开(≈50%)
        (230, {"value": "0"}),        # 关
        (240, {"value": "10"}),
        (240, {"value": "0"}),
        (160, {"value": "ptcon"}),
        (160, {"value": "ptcoff"}),
        (320, {"level": "2"}),
        (320, {"level": "1"}),
        (440, {"value": "2"}),
        (440, {"value": "1"}),
        (301, {"position": "driver", "level": "2"}),
        (370, {"position": "copilot", "level": "1"}),
    ]


def test_window_levels_are_on_the_0_to_10_scale():
    """车窗刻度是 **0~10**(四档: 0/2/5/10), 不是 0~100。

    证据:
      * EU 版在 B10 上实测: "only 0 / 2 / 5 / 10 move the car = closed / ~20% (vent) /
        ~50% / fully open", 其余取值云端受理但车不动;
      * 我们在 C10 上复核: `100`、`1` 发了车不动, `2`、`0` 确实动 —— 与 0~10 一致。
    """
    cli, calls = _capture()
    cli.windows_close()
    cli.windows_vent()
    cli.windows_half()
    cli.windows_open()
    assert [c[1] for c in calls] == [
        {"value": "0"}, {"value": "2"}, {"value": "5"}, {"value": "10"},
    ]
    assert all(c[0] == 230 for c in calls)


def test_window_never_sends_a_0_to_100_value():
    """别退回 0~100 的老刻度(旧值 "100" 云端受理但车端不动)。"""
    cli, calls = _capture()
    for fn in (cli.windows_open, cli.windows_vent, cli.windows_half, cli.windows_close):
        fn()
    for _, state in calls:
        assert int(state["value"]) <= 10


def test_ac_payload_has_the_seven_expected_fields():
    cli, calls = _capture()
    cli.ac_on(temperature=24, mode="cold", operate="manual", windlevel=3, circle="out")
    cmd, state = calls[0]
    assert cmd == 170
    assert set(state) == {"circle", "mode", "operate", "position", "temperature", "windlevel", "wshld"}
    assert state["temperature"] == "24"      # 温度是**字符串**
    assert state["windlevel"] == 3           # 风量是**整数**


def test_ac_off_uses_off_not_close():
    """关空调必须是 operate="off"。

    实测(读车端信号 1938):
      {"operate":"close"} → 云端 code=0, 车端**毫无反应**(表现为"Siri 能开不能关")
      {"operate":"off"}   → 18 秒内 1938 由 1 变 0 ✓
    """
    cli, calls = _capture()
    cli.ac_off()
    cmd, state = calls[0]
    assert cmd == 170
    assert state["operate"] == "off"
    assert state["operate"] != "close"
    # 照抄 App 的 AirController: 除 operate 外还要带上这几个字段 + 固定的 position/wshld
    for field in ("circle", "mode", "position", "temperature", "windlevel", "wshld"):
        assert field in state, f"关空调报文缺少 {field}"
    assert state["position"] == "all"


def test_ac_on_never_uses_the_bogus_close_value():
    cli, calls = _capture()
    cli.ac_on(temperature=26)
    _, state = calls[0]
    assert state["operate"] in ("manual", "auto")
    assert state["temperature"] == "26"


def test_sentry_uses_cmd_400_with_on_off():
    """哨兵 = cmdId 400 + {"value":"on"/"off"}。

    取证: CN 版 App 的 `MqttUtils.sendRemoteControl(getString2(1080), …)` ——
    1080="400"、14399="on"、10124="off", 且该方法开头就有 `can(400)` 权限判断;
    220 是我们早期从别处抄来的错码(EU 版也栽在这里: "220 accepted but never actuates")。
    """
    cli, calls = _capture()
    cli.sentry(on=True)
    cli.sentry(on=False)
    assert calls == [(400, {"value": "on"}), (400, {"value": "off"})]


def test_sentry_never_regresses_to_220():
    cli, calls = _capture()
    cli.sentry(on=True)
    assert calls[0][0] != 220


def test_trunk_and_sunshade_have_on_off_methods_for_switches():
    """后备箱 / 遮阳帘现在各是一个开关 → 客户端要有带 on 参数的方法。"""
    cli, calls = _capture()
    cli.trunk(on=True)
    cli.trunk(on=False)
    cli.sunshade(on=True)
    cli.sunshade(on=False)
    assert calls == [
        (130, {"value": "true"}), (130, {"value": "false"}),
        (240, {"value": "10"}), (240, {"value": "0"}),
    ]
    # 旧的 open/close 名字仍可用(脚本/文档里还在用)
    cli2, calls2 = _capture()
    cli2.open_trunk()
    cli2.close_trunk()
    assert calls2 == [(130, {"value": "true"}), (130, {"value": "false"})]
