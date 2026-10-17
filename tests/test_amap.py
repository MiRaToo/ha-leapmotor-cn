import asyncio
import importlib
import sys
import types
from pathlib import Path
import pytest

pkg=types.ModuleType('_amap_test');pkg.__path__=[str(Path(__file__).resolve().parents[1]/'custom_components/leapmotor')];sys.modules['_amap_test']=pkg
mod=importlib.import_module('_amap_test.amap')

def test_amap_key_params_and_clean_results():
    assert mod.validate_key('')==''
    key='ab'*16
    assert mod.search_params(key,'公园','上海')['key']==key
    for value in ['short','x'*32]:
        with pytest.raises(ValueError):mod.validate_key(value)
    with pytest.raises(ValueError):mod.search_params('', '公园')
    with pytest.raises(ValueError):mod.search_params(key, 'x')
    rows=mod.parse_places({'status':'1','pois':[{'id':'B123','name':'公园','address':'路1号','location':'121.4,31.2','cityname':[]},{'name':'broken','location':'nan,20'}]})
    assert rows==[{'poi_id':'B123','name':'公园','address':'路1号','city':'','latitude':31.2,'longitude':121.4,'coordinate_type':'gcj02'}]
    for bad in [{'status':'0','info':'secret-url'},{'status':'1','pois':None}]:
        with pytest.raises(ValueError):mod.parse_places(bad)

def test_amap_transport_is_fixed_and_errors_hide_key(monkeypatch):
    calls=[]
    class Response:
        status=200
        async def __aenter__(self):return self
        async def __aexit__(self,*args):pass
        async def json(self):return {'status':'1','pois':[]}
    class Session:
        def get(self,url,**kwargs):calls.append((url,kwargs));return Response()
    helper=types.ModuleType('homeassistant.helpers.aiohttp_client');helper.async_get_clientsession=lambda hass:Session()
    monkeypatch.setitem(sys.modules,'homeassistant.helpers.aiohttp_client',helper)
    assert asyncio.run(mod.search_places(None,'ab'*16,'公园'))==[]
    assert calls[0][0]=='https://restapi.amap.com/v3/place/text' and calls[0][1]['allow_redirects'] is False
    def bad(hass):raise RuntimeError('secret-key')
    helper.async_get_clientsession=bad
    with pytest.raises(ValueError) as exc:asyncio.run(mod.search_places(None,'ab'*16,'公园'))
    assert 'secret-key' not in str(exc.value)
