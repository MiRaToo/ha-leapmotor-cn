"""车型能力状态：只有明确能力证据才判不支持，不把缺信号当作无硬件。"""
import time

FEATURES = (
    ("lock", "车门锁", ("lock_status",), None, "lock"),
    ("trunk", "后备箱", ("trunk_open",), None, "trunk"),
    ("windows", "车窗状态", tuple(f"window_state_{i}" for i in range(1, 5)), None, "windows"),
    ("window_percent", "四窗开度", tuple(f"window_percent_{s}" for s in ("left_front","right_front","left_rear","right_rear")), None, "windows"),
    ("sunshade", "遮阳帘", ("sunshade_percent",), None, "sunshade"),
    ("rear_heat", "二排加热", ("seat_heat_rear_left","seat_heat_rear_right"), "22", None),
    ("rear_vent", "二排通风", ("seat_vent_rear_left","seat_vent_rear_right"), "67", None),
    ("third_heat_left", "三排左加热", ("seat_heat_third_left",), "85", None),
    ("third_heat_right", "三排右加热", ("seat_heat_third_right",), "93", None),
    ("charging_power", "充电功率", ("charging_voltage","charging_current"), None, None),
    ("charging_type", "交流/直流枪", ("dc_cable_connected","charge_plug"), None, None),
    ("fuel", "燃油量", ("fuel_ml",), None, None),
)
LABELS = {"available":"可用", "signal_missing":"信号缺失", "unsupported":"不支持",
          "unavailable":"暂不可用", "pending":"命令后待确认"}

def control_values(state):
    """可实测的控车状态；缺少部分关闭信号时保留未知，不能据此确认已关。"""
    def any_open(names):
        values = [state.get(name) for name in names]
        if any(value is not None and value > 0 for value in values):
            return True
        return False if all(value is not None for value in values) else None

    windows = any_open(tuple(f"window_state_{i}" for i in range(1, 5)))
    percentages = any_open(tuple("window_percent_" + side for side in
                           ("left_front", "right_front", "left_rear", "right_rear")))
    actual={"lock":state.locked,"trunk":state.flag("trunk_open"),
            "windows": True if windows is True or percentages is True else
                False if windows is False or percentages is False else None,
            "sunshade":state.sunshade_open}
    # 其它实体级控件也用同一条待确认链路，供车辆状态卡片显示总览。
    actual.update({
        "steering_heat": (state.get("steering_wheel_heating") or 0) > 0
            if state.get("steering_wheel_heating") is not None else None,
        "mirror_heat": any_open(("mirror_heat_left", "mirror_heat_right")),
        "healthy_charging": (state.get("healthy_charging") or 0) > 0
            if state.get("healthy_charging") is not None else None,
        "ac_on": state.flag("climate_on"),
        "ac_temp": state.get("climate_temp_left"),
    })
    mode = state.get("climate_mode")
    climate_on = state.flag("climate_on")
    actual["ac_hvac"] = ("off" if climate_on is False else
        {0: "fan_only", 1: "cool", 3: "heat", 4: "fan_only"}.get(mode)
        if climate_on is True else None)
    for key in ("seat_heat_driver", "seat_heat_copilot", "seat_vent_driver", "seat_vent_copilot",
                "seat_heat_rear_left", "seat_heat_rear_right", "seat_vent_rear_left",
                "seat_vent_rear_right", "seat_heat_third_left", "seat_heat_third_right"):
        signal = {"seat_heat_copilot":"seat_heat_passenger", "seat_vent_copilot":"seat_vent_passenger"}.get(key, key)
        actual[key] = state.get(signal)
    return actual


def pending_commands(state, recall, confirmation_pending=None):
    actual = control_values(state)
    if confirmation_pending is not None:
        return [key for key, value in actual.items()
                if confirmation_pending(key, value, getattr(state, "collect_time", 0))]
    # 兼容直接调用的旧集成/测试；生产路径传独立的确认跟踪器。
    return [key for key,value in actual.items() if (expected:=recall(key)) is not None and (value is None or value!=expected)]


def capability_view(state, abilities=(), *, unavailable=False, pending=(), energy_type="auto", now=None):
    now = time.time() if now is None else now
    signals = getattr(state, "signals", {}) or {}
    ab = {str(x) for x in abilities or ()}
    stamp = getattr(state, "collect_time", 0) or 0
    if stamp > 10_000_000_000: stamp /= 1000
    stale = state is None or unavailable or not stamp or now-stamp > 900 or stamp>now+120
    out=[]
    for key,label,keys,ability,command in FEATURES:
        present = [signals.get(k) is not None for k in keys]
        denied = (key=="fuel" and energy_type=="bev") or (ability is not None and bool(ab) and ability not in ab and not any(present))
        # 二排信号可能是所有车固定上报的零值；已有明确能力表时以能力位为准。
        if key in ("rear_heat","rear_vent") and ab and ability not in ab: denied=True
        status = "unsupported" if denied else "unavailable" if stale else "pending" if command in pending else "signal_missing" if not all(present) else "available"
        detail = "明确能源类型或已核对的能力位" if denied else "车况获取失败或采样已过期" if stale else "指令已受理，等待车端新采样" if status=="pending" else "本次采样未包含完整信号；不代表车辆不支持" if status=="signal_missing" else "本次采样有有效信号；不代表指令已在各车型验证"
        out.append({"key":key,"name":label,"status":status,"label":LABELS[status],"detail":detail})
    return out
