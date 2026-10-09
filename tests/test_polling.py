"""轮询间隔策略: 行驶中快、停车慢(参考 EU 版双档轮询思路)。"""
import pytest

import api_client


def test_parked_uses_the_configured_interval():
    assert api_client.pick_poll_seconds(300, 60, driving=False) == 300
    assert api_client.pick_poll_seconds(600, 60, driving=False) == 600


def test_driving_uses_the_faster_interval():
    assert api_client.pick_poll_seconds(300, 60, driving=True) == 60
    assert api_client.pick_poll_seconds(1800, 120, driving=True) == 120


def test_driving_never_slower_than_parked_setting():
    # 用户把停车间隔调到 60 时, 行驶间隔不能反而更慢
    assert api_client.pick_poll_seconds(60, 300, driving=True) == 60


def test_interval_has_a_60_second_floor():
    assert api_client.pick_poll_seconds(10, 10, driving=False) == 60
    assert api_client.pick_poll_seconds(10, 10, driving=True) == 60


# ── 四档轮询决策(行程记录引入): 行驶 6s / 出发提速 6s / 限流退避 / 停车 60s ──
def test_choose_poll_seconds_tiers():
    import api_client
    c = api_client.choose_poll_seconds
    assert c(parked=60, trip=6, driving=True, launch_boost=False) == 6      # 行驶 → 行程采样
    assert c(parked=60, trip=6, driving=False, launch_boost=False) == 60    # 停车 → 60
    assert c(parked=60, trip=6, driving=False, launch_boost=True) == 6      # 出发提速
    assert c(parked=120, trip=10, driving=True, launch_boost=False) == 10   # 用户自定义
    # 限流退避: 取"停车档 × 2"与 120 的较大者
    assert c(parked=60, trip=6, driving=True, launch_boost=False, rate_limited=True) == 120
    assert c(parked=120, trip=6, driving=True, launch_boost=False, rate_limited=True) == 240
    # 下限与钳制: 停车档的下限放宽到 20(可调), 行程档不会低于 floor(默认 6)
    assert c(parked=10, trip=6, driving=False, launch_boost=False) == api_client.MIN_PARKED_POLL_SECONDS
    assert c(parked=60, trip=1, driving=True, launch_boost=False) == 6


def test_is_rate_limited_detection():
    import api_client
    assert api_client.is_rate_limited({"code": 1023, "message": "环境被风控"})
    assert api_client.is_rate_limited({"code": 0, "message": "操作过于频繁, 请稍后再试"})
    assert not api_client.is_rate_limited({"code": 0, "message": "请求成功"})
    assert not api_client.is_rate_limited(None)



# ── 回归: 轮询间隔的最小值必须容许"行驶 6 秒"这一档(真机踩到) ──
def test_coordinator_allows_a_six_second_poll_interval():
    """`coordinator.timedelta_seconds` 曾经写死 `max(60, seconds)`, 让 6 秒档从未生效。

    真机证据(修前): 用户行驶中(车辆状态 = driving)轮询仍是 60 秒/次
    (「状态更新时间」历史 306 次间隔都是 60 秒); 行程点间隔中位 86 秒;
    24 段里 8 段因采样太稀被整段漏掉、只能"补记"。

    这条测试**直接检查源码里那个下限常量**(不依赖 HA 运行时)。
    """
    import pathlib as _p
    import re as _re

    src = (_p.Path(__file__).resolve().parent.parent / "custom_components" / "leapmotor"
           / "coordinator.py").read_text(encoding="utf-8")
    # 找出 timedelta_seconds 里用的下限(可以是字面量, 也可以是常量名)
    m = _re.search(r"def timedelta_seconds[\s\S]{0,400}?max\(([^,]+), seconds\)", src)
    assert m, "找不到 timedelta_seconds 的下限写法(改了实现就要同步这条测试)"
    token = m.group(1).strip()
    if token.isdigit():
        floor = int(token)
    else:
        cm = _re.search(_re.escape(token) + r"\s*=\s*(\d+)", src)
        assert cm, "下限常量 %s 找不到定义" % token
        floor = int(cm.group(1))
    assert floor <= 10, (
        "轮询间隔下限被钳到 %s 秒 —— 这会吃掉『行驶 6 秒』档(实测会导致行程点稀疏 + 大量补记)"
        % floor)
    # 再验证: 6 秒这一档确实不会被抬升
    assert max(floor, 6) == 6


# ── 短停快档 & 可调停车下限 ──
def test_short_stop_uses_fast_interval():
    """行程刚结束后的一段时间内也用快档 —— 抓"短停再出发"(下车买东西/接人)。

    否则停车档(默认 60s)会把这类短停 + 再出发整段漏掉(只能事后"补记", 没有轨迹)。
    """
    c = api_client.choose_poll_seconds
    # 短停窗口内: 用行程采样间隔
    assert c(parked=60, trip=6, driving=False, launch_boost=False, short_stop=True) == 6
    # 窗口外/关闭: 回到停车档
    assert c(parked=60, trip=6, driving=False, launch_boost=False, short_stop=False) == 60
    # 与其它档位的优先级: 行驶/提速仍然生效(不冲突)
    assert c(parked=60, trip=6, driving=True, launch_boost=False, short_stop=False) == 6
    # 限流退避优先于短停快档(被风控时不该继续高频)
    assert c(parked=60, trip=6, driving=False, launch_boost=False,
             short_stop=True, rate_limited=True) == 120


def test_parked_floor_can_go_below_60_but_not_below_20():
    """停车档下限放宽到 20 秒(用户可调) —— 但不会低于 20(再密对停车没意义)。"""
    c = api_client.choose_poll_seconds
    assert c(parked=20, trip=6, driving=False, launch_boost=False) == 20
    assert c(parked=30, trip=6, driving=False, launch_boost=False) == 30
    assert c(parked=10, trip=6, driving=False, launch_boost=False) == api_client.MIN_PARKED_POLL_SECONDS
    assert api_client.MIN_PARKED_POLL_SECONDS == 20
    # 默认仍是 60
    assert api_client.choose_poll_seconds(parked=60, trip=6, driving=False, launch_boost=False) == 60


def test_short_stop_defaults_and_bounds():
    """默认值要在合理范围(默认开启 5 分钟, 允许 0=关闭)。"""
    import pathlib as _p
    import re as _re
    src = (_p.Path(__file__).resolve().parent.parent / "custom_components" / "leapmotor"
           / "const.py").read_text(encoding="utf-8")
    d = int(_re.search(r"DEFAULT_SHORT_STOP_SECONDS\s*=\s*(\d+)", src).group(1))
    m = int(_re.search(r"MAX_SHORT_STOP_SECONDS\s*=\s*(\d+)", src).group(1))
    assert 0 < d <= m, "默认短停窗口应在 (0, 上限] 之间"
    assert m >= 600, "上限至少给到 10 分钟"


# ── 驻车照片: 递增退避窗口(A+C) ──
def test_photo_retry_backoff_is_increasing():
    """照片"等上传"的重试节奏必须**递增**(头几次快、之后慢), 且窗口给足。

    设计取舍: 车端拍照是异步上传的, 传完的时刻我们控制不了 ——
    窗口给足(不错过) + 节奏递增(不白问) + 拿到新照片立即停(见 _refresh_photo)。
    """
    import pathlib as _p
    import re as _re
    src = (_p.Path(__file__).resolve().parent.parent / "custom_components" / "leapmotor"
           / "const.py").read_text(encoding="utf-8")
    steps = _re.search(r"PHOTO_RETRY_STEPS\s*=\s*\(([^)]+)\)", src)
    assert steps, "找不到 PHOTO_RETRY_STEPS"
    vals = [int(x.strip()) for x in steps.group(1).split(",") if x.strip()]
    assert len(vals) >= 3, "至少三级退避"
    assert vals == sorted(vals), "退避间隔必须单调不减: %s" % vals
    assert vals[0] <= 20, "第一次要快(照片通常秒级到): %s" % vals[0]
    assert vals[-1] >= 120, "最后一级要够慢(车端迟迟不传时收敛): %s" % vals[-1]
    window = int(_re.search(r"PHOTO_RETRY_WINDOW_SECONDS\s*=\s*(\d+)", src).group(1))
    assert window >= 600, "窗口太短会错过慢上传的照片: %ss" % window


def test_heavy_data_is_decoupled_from_fast_polling():
    """重数据(里程/能耗/配置)有独立节奏, 不跟着 6 秒档高频拉。

    真机场景: 短停快档/出发提速会把轮询打到 6 秒 —— 但里程/能耗 10 分钟内几乎不变,
    跟着高频拉纯属浪费(还会顺带触发写库/前端刷新)。
    """
    import pathlib as _p
    import re as _re
    src = (_p.Path(__file__).resolve().parent.parent / "custom_components" / "leapmotor"
           / "coordinator.py").read_text(encoding="utf-8")
    # 重数据分支必须由 _last_heavy + HEAVY_REFRESH_SECONDS 控制(与轮询档位无关)
    m = _re.search(r"if self\._last_heavy == 0\.0 or \(not driving", src)
    assert m, "重数据的触发条件应只看 _last_heavy(与轮询档位解耦)"
    assert "now - self._last_heavy >= HEAVY_REFRESH_SECONDS" in src, "重数据间隔应使用常量"
    c = (_p.Path(__file__).resolve().parent.parent / "custom_components" / "leapmotor"
         / "const.py").read_text(encoding="utf-8")
    heavy = int(_re.search(r"HEAVY_REFRESH_SECONDS\s*=\s*(\d+)", c).group(1))
    assert heavy >= 300, "重数据间隔不该太短: %ss" % heavy
