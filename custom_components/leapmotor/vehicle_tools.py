"""预约、目的地与全景壁纸；按所选实体解析车辆，写入均要求管理员。"""
from __future__ import annotations
import base64,io,json,math,time,uuid
from datetime import datetime,timedelta
from zoneinfo import ZoneInfo

def weekdays(value):
    if not isinstance(value,list) or any(type(x)is not int or not 0<=x<=6 for x in value) or len(set(value))!=len(value):
        raise ValueError("重复日期须为周日到周六，不能重复")
    return sorted(value)

def preheat_controls(response):
    if not isinstance(response,dict) or response.get("code")!=0:raise ValueError("车端预热预约暂不可读，未修改已有预约")
    data=response.get("data")
    if data in (None,""):return []
    if isinstance(data,str):data=json.loads(data)
    if not isinstance(data,dict) or not isinstance(data.get("controls"),list):raise ValueError("预热预约响应格式未识别，未修改已有预约")
    if not all(isinstance(x,dict) and x.get("set_id") for x in data["controls"]):raise ValueError("预热预约缺少编号")
    return data["controls"]

def preheat_entry(data,timezone,*,now=None,vin=""):
    days=weekdays(data.get("days"));clock=str(data.get("start") or "")
    from .charging import minute_of
    minute_of(clock)
    if type(data.get("enabled"))is not bool:raise ValueError("预约开关无效")
    current=datetime.now(ZoneInfo(timezone)) if now is None else now
    start=current.replace(hour=int(clock[:2]),minute=int(clock[3:]),second=0,microsecond=0)
    if start<=current:start+=timedelta(days=1)
    if days:
        while (start.weekday()+1)%7 not in days:start+=timedelta(days=1)
    return {"set_id":str(data.get("id") or (f"Android_{vin}_{int(current.timestamp()*1000)}" if vin else uuid.uuid4().hex)),"on":"1" if data["enabled"] else "0",
            "start_time":start.strftime("%Y-%m-%d %H:%M:%S"),"update_time":str(int(current.timestamp()*1000)),"days":days}

def validate_panorama(encoded):
    if not isinstance(encoded,str) or len(encoded)>2_800_000:raise ValueError("图片须不超过 2 MiB")
    try:raw=base64.b64decode(encoded,validate=True)
    except Exception:raise ValueError("图片编码无效") from None
    if len(raw)>2*1024*1024:raise ValueError("图片须不超过 2 MiB")
    from PIL import Image
    try:
        with Image.open(io.BytesIO(raw)) as im:
            width,height=im.size;fmt=im.format
            if fmt not in ("JPEG","PNG"):raise ValueError("只支持 JPEG 或 PNG")
            if not 1920<width<=4096 or not 960<height<=2048:raise ValueError("全景图片宽须大于 1920、高须大于 960，最大 4096×2048")
            if abs(width/height-2)>.02:raise ValueError("全景图片须为 2:1 比例")
            im.verify()
    except ValueError:raise
    except Exception:raise ValueError("图片无法读取或已损坏") from None
    return raw,"image/jpeg" if fmt=="JPEG" else "image/png"

def register(hass):
    import voluptuous as vol
    from homeassistant.components import websocket_api as ws
    from homeassistant.helpers import entity_registry as er
    from .const import DOMAIN
    from .amap import CONF_AMAP_KEY, search_places, validate_key

    def coordinator(msg):
        entry=er.async_get(hass).async_get(msg["entity_id"])
        coord=(hass.data.get(DOMAIN) or {}).get(entry.config_entry_id) if entry and entry.platform==DOMAIN else None
        if coord is None:raise ValueError("没有找到所选车辆，请等待实体加载")
        return coord

    def require(coord,cmd):
        if not coord.vehicle or not coord.vehicle.can(cmd):raise ValueError("该账号没有此功能权限")

    async def call(coord,method,**kwargs):
        response=await coord.async_call(method,**kwargs)
        if not isinstance(response,dict) or response.get("code") not in (0,200):raise ValueError("未能确认云端受理，请先查看车端状态")
        return response

    @ws.websocket_command({vol.Required("type"):"leapmotor/vehicle_tools/info",vol.Required("entity_id"):str,vol.Optional("section",default="schedule"):vol.In(["schedule","media","amap"])})
    @ws.require_admin
    @ws.async_response
    async def info(hass,connection,msg):
        try:
            c=coordinator(msg);plan=(c.data or {}).get("charge_plan") or {}
            controls=[];error=""
            can_preheat=bool(c.vehicle and c.vehicle.can(161))
            if can_preheat and msg["section"]=="schedule":
                try:controls=preheat_controls(await hass.async_add_executor_job(c.client.get_preheat_schedule,c.vin))
                except Exception:error="预热预约暂不可读，保留原计划；可稍后重新读取"
            connection.send_result(msg["id"],{"charge":plan,"preheat":controls,"preheat_error":error,
                "can_charge":bool(c.vehicle and c.vehicle.can(190)),"can_preheat":can_preheat,
                "can_destination":bool(c.vehicle and c.vehicle.can(180)),"amap_configured":bool(c.entry.options.get(CONF_AMAP_KEY)),"timezone":hass.config.time_zone})
        except Exception as err:connection.send_error(msg["id"],"unavailable",str(err)[:160])

    @ws.websocket_command({vol.Required("type"):"leapmotor/vehicle_tools/save",vol.Required("entity_id"):str,
                          vol.Required("kind"):vol.In(["charge","preheat","destination","panorama"]),vol.Required("data"):dict})
    @ws.require_admin
    @ws.async_response
    async def save(hass,connection,msg):
        try:
            c=coordinator(msg);data=msg["data"];kind=msg["kind"]
            result={"accepted":True,"message":"云端已受理，请以车端实际结果为准"}
            if kind=="charge":
                require(c,190);days=weekdays(data.get("days"))
                if type(data.get("recharge"))is not bool:raise ValueError("继续充电开关无效")
                cycles=",".join("1" if i in days else "0" for i in range(7))
                await call(c,"set_charge_plan",vin=c.vin,cycles=cycles,circulation=int(bool(days)),recharge=int(data["recharge"]))
                for key,val in {"cycles":cycles,"circulation":int(bool(days)),"recharge":int(data["recharge"])}.items():c.set_charge_plan_cache(key,val)
            elif kind=="preheat":
                require(c,161)
                controls=preheat_controls(await hass.async_add_executor_job(c.client.get_preheat_schedule,c.vin))
                entry=preheat_entry(data,hass.config.time_zone,vin=c.vin)
                if data.get("id") and not any(x.get("set_id")==data["id"] for x in controls):raise ValueError("该预约已改变，请重新读取")
                updated=[{**x,**entry} if x.get("set_id")==entry["set_id"] else x for x in controls]
                if not data.get("id"):updated.append(entry)
                if len(updated)>20:raise ValueError("预约数量已达到上限")
                await call(c,"set_preheat_schedule",vin=c.vin,controls=updated)
                result["preheat"]=entry  # 新预约编号立即交回，确认期间再次修改不会重复新建。
            elif kind=="destination":
                require(c,180)
                name=str(data.get("name") or "").strip();address=str(data.get("address") or "").strip()
                if not name or len(name)>120 or len(address)>300:raise ValueError("请填写有效目的地名称和地址")
                await call(c,"send_destination",vin=c.vin,name=name,address=address,latitude=data.get("latitude"),longitude=data.get("longitude"),poi_id=str(data.get("poi_id") or "")[:128],coordinate_type=str(data.get("coordinate_type") or "gcj02"),use_wgs84="39" in {str(x) for x in c.vehicle.abilities})
            else:
                image,mime=await hass.async_add_executor_job(validate_panorama,data.get("image"))
                await call(c,"upload_panorama",vin=c.vin,image=image,mime=mime)
            connection.send_result(msg["id"],result)
        except Exception as err:connection.send_error(msg["id"],"request_failed",str(err)[:180])

    @ws.websocket_command({vol.Required("type"):"leapmotor/map/search",vol.Required("entity_id"):str,vol.Required("keywords"):str,vol.Optional("city",default=""):str})
    @ws.require_admin
    @ws.async_response
    async def search(hass,connection,msg):
        try:
            c=coordinator(msg);now=time.monotonic()
            if now-getattr(c,"_amap_search_at",0)<1:raise ValueError("请稍候再搜索")
            c._amap_search_at=now
            rows=await search_places(hass,c.entry.options.get(CONF_AMAP_KEY),msg["keywords"],msg["city"])
            connection.send_result(msg["id"],{"places":rows})
        except Exception as err:connection.send_error(msg["id"],"search_failed",str(err)[:160])

    @ws.websocket_command({vol.Required("type"):"leapmotor/amap/save",vol.Required("entity_id"):str,vol.Required("key"):str})
    @ws.require_admin
    @ws.async_response
    async def save_amap(hass,connection,msg):
        try:
            c=coordinator(msg)
            key=validate_key(msg["key"])
            options={**c.entry.options}
            if key:options[CONF_AMAP_KEY]=key
            else:options.pop(CONF_AMAP_KEY,None)
            hass.config_entries.async_update_entry(c.entry,options=options)
            connection.send_result(msg["id"],{"amap_configured":bool(key)})
        except Exception as err:connection.send_error(msg["id"],"request_failed",str(err)[:160])

    ws.async_register_command(hass,info);ws.async_register_command(hass,save);ws.async_register_command(hass,search);ws.async_register_command(hass,save_amap)
