"""驻车充电计量、未知帧边界和跨日峰谷计费的回归。无网络及 HA 运行时依赖。"""
import asyncio
from datetime import datetime
from pathlib import Path
import sys
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "custom_components/leapmotor"))
from charging import ChargeRecorder, MAX_GAP_SECONDS, validate_tariff, interval_buckets, session_tariff
from api_client import CarState

ZONE = ZoneInfo("Asia/Hong_Kong")

def test_ac_dc_efficiency_changes_grid_energy_and_cost_separately_and_keeps_legacy():
    tariff=validate_tariff({'efficiency':.9,'ac_efficiency':.8,'dc_efficiency':.95,'peak_price':1,'valley_price':1})
    ac=session_tariff({'charge_types':['ac']},tariff)
    dc=session_tariff({'charge_types':['dc']},tariff)
    assert ac['efficiency']==.8 and dc['efficiency']==.95
    assert session_tariff({'charge_types':['unknown']},tariff)['efficiency']==.9
    assert session_tariff({'charge_types':['ac']},validate_tariff({'efficiency':.85}))['efficiency']==.85
    start=datetime(2026,10,16,12,tzinfo=ZONE).timestamp()
    a=interval_buckets(start,start+3600,8,ac,ZONE)
    d=interval_buckets(start,start+3600,8,dc,ZONE)
    assert sum(x['grid_kwh'] for x in a)==pytest.approx(10)
    assert sum(x['cost'] for x in d)==pytest.approx(8/.95)
    for bad in [0,.49,1.01,float('nan')]:
        with pytest.raises(ValueError):validate_tariff({'ac_efficiency':bad})
        with pytest.raises(ValueError):validate_tariff({'dc_efficiency':bad})
def stamp(s):
    return datetime.strptime(s, "%Y-%m-%d %H:%M:%S").replace(tzinfo=ZONE).timestamp()
T0 = stamp("2026-10-14 22:59:00")

class MemoryStore:
    def __init__(self): self.data = {}
    async def async_load(self): return self.data
    async def async_save(self, data): self.data = data
    def async_delay_save(self, fn, _delay): self.data = fn()

def recorder():
    return ChargeRecorder(None, "TEST", 70, store=MemoryStore(), timezone="Asia/Hong_Kong")

def test_dc_periods_split_at_boundaries_and_do_not_change_ac_or_overrides():
    tariff=validate_tariff({'peak_price':2,'valley_price':1,'ac_peak_price':.8,'ac_valley_price':.3,'efficiency':1,
        'dc_periods':[{'start':'23:00','end':'07:00','price':.6},{'start':'07:00','end':'18:00','price':1.2},{'start':'18:00','end':'23:00','price':1.8}]})
    at=stamp('2026-10-14 22:59:00')
    dc=session_tariff({'charge_types':['dc']},tariff)
    rows=interval_buckets(at,at+120,2,dc,ZONE)
    assert sum(r['cost'] for r in rows)==pytest.approx(2.4)
    ac=session_tariff({'charge_types':['ac']},tariff)
    assert sum(r['cost'] for r in interval_buckets(at,at+120,2,ac,ZONE))==pytest.approx(1.1)
    override=session_tariff({'charge_types':['dc'],'price_override':{'mode':'unit','value':.9}},tariff)
    assert sum(r['cost'] for r in interval_buckets(at,at+120,2,override,ZONE))==pytest.approx(1.8)
    unknown=session_tariff({'charge_types':['unknown']},tariff)
    assert sum(r['cost'] for r in interval_buckets(at,at+120,2,unknown,ZONE))==pytest.approx(3)

def test_dc_periods_validate_coverage_overlap_and_prices():
    for periods in [[],[{'start':'00:00','end':'23:59','price':1}],
        [{'start':'23:00','end':'07:00','price':1},{'start':'06:00','end':'23:00','price':1}],
        [{'start':'00:00','end':'00:00','price':float('nan')}],
        [{'start':'25:00','end':'00:00','price':1}],
        [{'start':'00:00','end':'00:00','price':None}]]:
        with pytest.raises(ValueError):validate_tariff({'dc_periods':periods})
    assert validate_tariff({'dc_periods':[{'start':'00:00','end':'00:00','price':0}]})['dc_periods'][0]['price']==0

def test_dc_periods_survive_storage_and_total_override():
    rec=recorder();feed(rec,frame(T0),frame(T0+120));feed(rec,frame(T0+180,charging=0))
    asyncio.run(rec.set_tariff({'efficiency':1,'dc_periods':[{'start':'00:00','end':'00:00','price':2}]}))
    ident=rec.sessions[0]['id'];rec.sessions[0]['charge_types']=['dc']
    asyncio.run(rec.set_session_price(ident,'total',5))
    restored=ChargeRecorder(None,'TEST',70,store=rec._store,timezone='Asia/Hong_Kong');asyncio.run(restored.async_load())
    view=restored.view(now=T0+180)
    assert view['summary']['cost']==5 and view['sessions'][0]['cost']==5
    assert view['tariff']['dc_periods'][0]['price']==2

def test_ac_tariff_and_per_session_overrides_survive_reload():
    rec=recorder();at=stamp("2026-10-14 23:59:00")
    for ts in [at,at+120]:
        st=frame(ts);st.signals.update(dc_cable_connected=0,charge_plug=1);feed(rec,st)
    feed(rec,frame(at+180,charging=0))
    asyncio.run(rec.set_tariff({"peak_price":2,"valley_price":2,"ac_peak_price":.5,"ac_valley_price":.5}))
    v=rec.view(now=at+180);assert v["summary"]["cost"]==.11
    ident=rec.sessions[0]["id"]
    asyncio.run(rec.set_session_price(ident,"total",3))
    v=rec.view(now=at+180);assert v["summary"]["cost"]==3
    assert [r["cost"] for r in v["days"] if r["kwh"]>0]==[1.5,1.5]
    asyncio.run(rec.set_tariff({"peak_price":10,"ac_valley_price":8}))
    assert rec.view(now=at+180)["sessions"][0]["cost"]==3
    other=ChargeRecorder(None,"TEST",70,store=rec._store,timezone="Asia/Hong_Kong");asyncio.run(other.async_load())
    assert other.view(now=at+180)["sessions"][0]["price_override"]=={"mode":"total","value":3}
    asyncio.run(other.set_session_price(ident,"unit",.9))
    assert other.view(now=at+180)["summary"]["cost"]==.2
    asyncio.run(other.set_session_price(ident,"auto"))
    assert other.view(now=at+180)["sessions"][0]["price_override"] is None

def test_price_override_rejects_active_and_failed_save_is_atomic():
    rec=recorder();feed(rec,frame(T0),frame(T0+60))
    with pytest.raises(ValueError):asyncio.run(rec.set_session_price(rec.active["id"],"total",5))
    feed(rec,frame(T0+120,charging=0));ident=rec.sessions[0]["id"]
    for mode,v in [("unit",float('nan')),("total",-1),("bad",2)]:
        with pytest.raises(ValueError):asyncio.run(rec.set_session_price(ident,mode,v))
    async def fail(_):raise OSError('storage unavailable')
    rec._store.async_save=fail
    with pytest.raises(OSError):asyncio.run(rec.set_session_price(ident,"total",5))
    assert not rec.sessions[0].get('price_override')

def test_price_save_keeps_a_session_finished_during_io():
    rec=recorder();feed(rec,frame(T0),frame(T0+60),frame(T0+120,charging=0));ident=rec.sessions[0]['id']
    feed(rec,frame(T0+180),frame(T0+240))
    async def save_while_finish(_):rec._finish(T0+240,'停止充电')
    rec._store.async_save=save_while_finish
    asyncio.run(rec.set_session_price(ident,'total',8))
    assert len(rec.sessions)==2 and rec.sessions[0]['price_override']['value']==8
    assert len(rec._store.data['sessions'])==2

def test_actual_total_without_energy_is_assigned_to_end_date():
    rec=recorder();feed(rec,frame(T0,power=False),frame(T0+60,power=False),frame(T0+120,charging=0))
    asyncio.run(rec.set_session_price(rec.sessions[0]['id'],'total',8))
    v=rec.view(now=T0+180)
    assert v['summary']['cost']==8 and v['summary']['kwh']==0

def frame(at, soc=40, charging=1, gear=0, speed=0, power=True):
    signals = {"soc": soc, "charge_connection": charging, "gear": gear, "speed": speed}
    if power: signals.update(charging_voltage=600, charging_current=-10)
    return CarState(collect_time=int(at*1000), signals=signals)

def feed(rec, *frames):
    for st in frames: rec.process(st, now=st.collect_time/1000)

def test_reev_driving_soc_gain_is_never_a_charge():
    rec = recorder()
    feed(rec, frame(T0,40,gear=1), frame(T0+60,45,gear=1), frame(T0+120,50,charging=1,speed=10))
    assert rec.active is None and rec.sessions == []
    assert rec.view(now=T0+180)["summary"]["kwh"] == 0

def test_speed_guard_rejects_corrupt_parked_flag():
    rec = recorder()
    st = SimpleNamespace(collect_time=int(T0*1000),soc=40,vehicle_state="parked",charging=True,
                         get=lambda k: {"speed":5,"gear":0,"charging_voltage":600,"charging_current":-10}.get(k))
    rec.process(st,now=T0)
    assert rec.active is None

def test_plugged_idle_and_unknown_state_do_not_start():
    rec = recorder()
    feed(rec, frame(T0,charging=2), frame(T0+60,charging=0))
    missing = CarState(collect_time=int((T0+120)*1000),signals={"soc":50})
    feed(rec, missing)
    assert rec.active is None and rec.sessions == []

def test_power_integration_and_no_final_unconfirmed_interval():
    rec = recorder()
    feed(rec, frame(T0), frame(T0+60), frame(T0+120,41,charging=0))
    v = rec.view(now=T0+120)
    assert len(v["sessions"]) == 1 and not v["active"]
    assert v["sessions"][0]["kwh"] == pytest.approx(.1)
    assert v["sessions"][0]["ended_at"] == T0+60
    assert v["summary"]["cost"] is None

def test_soc_fallback_and_duplicate_frames():
    rec = recorder()
    feed(rec, frame(T0,40,power=False),frame(T0+60,41,power=False))
    rec.process(frame(T0+60,43,power=False),now=T0+120)
    rec.process(frame(T0-10,45,power=False),now=T0+120)
    v=rec.view(now=T0+120)
    assert v["summary"]["kwh"] == pytest.approx(.7)
    assert v["sessions"][0]["sources"] == ["soc"]


def test_missing_timestamp_breaks_active_integration():
    rec = recorder()
    feed(rec, frame(T0), frame(T0+60))
    rec.process(frame(0),now=T0+120)
    feed(rec, frame(T0+180),frame(T0+240))
    v=rec.view(now=T0+240)
    assert len(v["sessions"]) == 2
    assert v["summary"]["kwh"] == pytest.approx(.2)
    assert v["sessions"][1]["partial"] is True


def test_charging_power_and_type_require_plug_evidence():
    rec=recorder()
    a,b=frame(T0),frame(T0+60)
    for st in (a,b):st.signals.update(dc_cable_connected=0,charge_plug=1)
    feed(rec,a,b)
    s=rec.view(now=T0+60)["sessions"][0]
    assert s["charge_type"]=="ac" and s["peak_kw"]==6 and s["average_kw"]==6
    assert len(s["power_samples"])==2
    assert s["soc_samples"]==[40,40]
    other=recorder();feed(other,frame(T0),frame(T0+60))
    assert other.view(now=T0+60)["sessions"][0]["charge_type"]=="unknown"

def test_soc_samples_follow_power_samples_and_preserve_missing_frames():
    rec=recorder()
    feed(rec,frame(T0,40),frame(T0+60,41))
    missing=frame(T0+120)
    missing.signals.pop("soc")
    feed(rec,missing)
    session=rec.view(now=T0+120)["sessions"][0]
    assert [p[0] for p in session["power_samples"]]==[T0,T0+60,T0+120]
    assert session["soc_samples"]==[40,41,None]

def test_missing_and_stale_timestamps_do_not_create_samples():
    rec = recorder()
    rec.process(frame(0),now=T0)
    rec.process(frame(T0),now=T0+MAX_GAP_SECONDS+1)
    rec.process(frame(T0+1000),now=T0)
    assert rec.active is None


def test_repeated_old_frames_cannot_keep_charge_running_forever():
    rec=recorder();feed(rec,frame(T0),frame(T0+60))
    v=rec.view(now=T0+60+MAX_GAP_SECONDS+1)
    assert v["active"] is False and v["sessions"][0]["partial"] is True
    rec.process(frame(T0+60),now=T0+60+MAX_GAP_SECONDS+1)
    assert rec.active is None and rec.sessions[-1]["reason"]=="遥测中断"

def test_gap_and_unknown_interruption_do_not_bridge_energy():
    rec=recorder()
    feed(rec,frame(T0),frame(T0+60),frame(T0+MAX_GAP_SECONDS+120,60))
    v=rec.view(now=T0+MAX_GAP_SECONDS+120)
    assert len(v["sessions"])==2 and v["summary"]["kwh"]==pytest.approx(.1)
    assert v["sessions"][1]["partial"] is True
    unknown = CarState(collect_time=int((T0+MAX_GAP_SECONDS+180)*1000),signals={"soc":65})
    feed(rec,unknown)
    assert rec.active is None and rec.sessions[-1]["reason"]=="状态未知"

def test_soc_drop_does_not_get_charged_as_positive_energy():
    rec=recorder();feed(rec,frame(T0,60),frame(T0+60,55))
    assert rec.view(now=T0+60)["summary"]["kwh"]==0
    assert rec.active["partial"] is True

def test_price_boundary_and_efficiency():
    rec=recorder()
    asyncio.run(rec.set_tariff({"peak_price":1,"valley_price":.5}))
    feed(rec,frame(T0),frame(T0+120))
    v=rec.view(now=T0+120)
    s=v["sessions"][0]
    assert s["peak_kwh"]==pytest.approx(.1) and s["valley_kwh"]==pytest.approx(.1)
    assert s["grid_kwh"]==pytest.approx(.222,abs=.001) and s["cost"]==.17

def test_cross_midnight_and_window_clipping():
    rec=recorder();t=stamp("2026-10-14 23:59:00")
    feed(rec,frame(t),frame(t+120))
    assert rec.view(days=1,now=t+120)["summary"]["kwh"]==pytest.approx(.1)
    assert rec.view(days=2,now=t+120)["summary"]["kwh"]==pytest.approx(.2)

def test_reprice_history_and_persist():
    rec=recorder();feed(rec,frame(T0),frame(T0+120))
    asyncio.run(rec.set_tariff({"peak_price":0,"valley_price":0}))
    assert rec.view(now=T0+120)["summary"]["cost"]==0
    asyncio.run(rec.set_tariff({"peak_price":2,"valley_price":2}))
    assert rec.view(now=T0+120)["summary"]["cost"]==.44
    assert rec._store.data["tariff"]["peak_price"]==2

def test_restart_ends_active_and_never_integrates_across_restart():
    rec=recorder();feed(rec,frame(T0),frame(T0+60))
    other=ChargeRecorder(None,"TEST",70,store=rec._store,timezone="Asia/Hong_Kong")
    asyncio.run(other.async_load())
    feed(other,frame(T0+120))
    v=other.view(now=T0+120)
    assert v["summary"]["kwh"]==pytest.approx(.1)
    assert len(v["sessions"])==2 and v["sessions"][1]["reason"]=="重启中断"

@pytest.mark.parametrize("bad",[{"peak_price":float("nan")},{"valley_price":-1},{"efficiency":0},
                                {"valley_start":"24:00"},{"valley_end":"00:60"},{"valley_end":"23:00"}])
def test_invalid_prices_and_times_are_rejected(bad):
    with pytest.raises(ValueError): validate_tariff(bad)

def test_failed_settings_save_keeps_current_tariff():
    rec=recorder()
    async def fail(_): raise OSError("storage unavailable")
    rec._store.async_save=fail
    with pytest.raises(OSError):asyncio.run(rec.set_tariff({"peak_price":2}))
    assert rec.tariff["peak_price"] is None

def test_tariff_splitting_respects_timezone_not_host_timezone():
    t=stamp("2026-10-15 07:00:00")
    rows=interval_buckets(t-60,t+60,.2,validate_tariff({"peak_price":1,"valley_price":.5}),ZONE)
    assert {r["band"]:round(r["kwh"],3) for r in rows}=={"valley":.1,"peak":.1}
