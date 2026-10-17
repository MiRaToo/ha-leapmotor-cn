import base64,importlib,io,json,sys,types
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo
import pytest
from PIL import Image

pkg=types.ModuleType('_tools_test');pkg.__path__=[str(Path(__file__).resolve().parents[1]/'custom_components/leapmotor')];sys.modules['_tools_test']=pkg
mod=importlib.import_module('_tools_test.vehicle_tools')

def test_schedule_parse_unknown_fails_closed_and_keeps_ids():
    assert mod.preheat_controls({'code':0,'data':''})==[]
    rows=[{'set_id':'one','days':[0,6],'on':'1','start_time':'2026-10-16 07:00:00'}]
    assert mod.preheat_controls({'code':0,'data':json.dumps({'controls':rows})})==rows
    for bad in [{'code':100,'data':None},{'code':0,'data':{}},{'code':0,'data':{'controls':[{}]}}]:
        with pytest.raises(ValueError):mod.preheat_controls(bad)

def test_weekdays_and_preheat_use_sunday_zero_and_ha_timezone():
    now=datetime(2026,10,15,20,tzinfo=ZoneInfo('Asia/Hong_Kong'))
    row=mod.preheat_entry({'enabled':True,'start':'07:00','days':[0,6]},'Asia/Hong_Kong',now=now,vin='TEST')
    assert row['start_time']=='2026-10-17 07:00:00' and row['days']==[0,6] and row['on']=='1'
    assert row['set_id'].startswith('Android_TEST_') and 'end_time' not in row
    single=mod.preheat_entry({'id':'keep','enabled':False,'start':'07:00','days':[]},'Asia/Hong_Kong',now=now)
    assert single['set_id']=='keep' and single['start_time']=='2026-10-16 07:00:00'
    for bad in [[7],[0,0],[False],None]:
        with pytest.raises(ValueError):mod.weekdays(bad)

def encoded(size):
    out=io.BytesIO();Image.new('RGB',size,'gray').save(out,format='JPEG');return base64.b64encode(out.getvalue()).decode()

def test_panorama_checks_actual_file_dimensions_and_ratio():
    raw,mime=mod.validate_panorama(encoded((2048,1024)))
    assert raw.startswith(b'\xff\xd8') and mime=='image/jpeg'
    for size in [(1920,960),(2048,960),(2048,1100),(4100,2050)]:
        with pytest.raises(ValueError):mod.validate_panorama(encoded(size))
    for bad in ['bad',base64.b64encode(b'not an image').decode(),'x'*2_800_001]:
        with pytest.raises(ValueError):mod.validate_panorama(bad)
