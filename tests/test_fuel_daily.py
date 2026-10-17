import importlib,sys,types
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo
from test_charging import MemoryStore,frame

pkg=types.ModuleType("_fuel_test");pkg.__path__=[str(Path(__file__).resolve().parents[1]/"custom_components/leapmotor")]
sys.modules["_fuel_test"]=pkg
FuelDayRecorder=importlib.import_module("_fuel_test.fuel_daily").FuelDayRecorder
T=datetime(2026,10,14,23,59,30,tzinfo=ZoneInfo("Asia/Hong_Kong")).timestamp()
def recorder():return FuelDayRecorder(None,"TEST","Asia/Hong_Kong",store=MemoryStore())
def send(rec,at,ml,*,reev=True,gear=1):
    st=frame(at,gear=gear);st.signals["fuel_ml"]=ml;rec.process(st,reev=reev,now=at)

def test_bev_false_fuel_and_parked_are_excluded():
    r=recorder();send(r,T,45000,reev=False);send(r,T+60,44900,reev=False)
    send(r,T+120,44800,gear=0);send(r,T+180,44700,gear=0)
    assert r.snapshot()=={}

def test_midnight_split_and_duplicate():
    r=recorder();send(r,T,45000);send(r,T+60,44900);send(r,T+60,44700)
    assert r.snapshot()=={"2026-10-14":.05,"2026-10-15":.05}

def test_refuel_missing_and_gap_not_consumption():
    r=recorder();send(r,T,45000);send(r,T+60,49000);send(r,T+120,None)
    send(r,T+180,48900);send(r,T+1900,48000)
    assert r.snapshot()=={}
