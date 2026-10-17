"""高德 Web 服务入口。密钥只留在 HA，查询只由用户显式发起。"""
from __future__ import annotations
import asyncio
import math
import re

CONF_AMAP_KEY = "amap_web_key"

def validate_key(value):
    key = str(value or "").strip()
    if key and not re.fullmatch(r"[0-9a-fA-F]{32}", key):
        raise ValueError("请输入高德 Web 服务类型的 32 位 Key，或留空禁用")
    return key

def search_params(key, keywords, city=""):
    key = validate_key(key)
    if not key:
        raise ValueError("请先在集成配置中填写高德 Web 服务 Key")
    keywords = str(keywords).strip(); city = str(city).strip()
    if not 2 <= len(keywords) <= 80 or len(city) > 40:
        raise ValueError("地点关键词须为 2～80 字，城市不超过 40 字")
    return {"key":key,"keywords":keywords,"city":city,"offset":"10","page":"1","extensions":"base","output":"JSON"}

def parse_places(data):
    if not isinstance(data,dict) or str(data.get("status")) != "1":
        raise ValueError("高德查询失败，请检查 Key 类型、配额与 IP 白名单")
    rows = data.get("pois")
    if not isinstance(rows,list):
        raise ValueError("高德地点响应格式未识别")
    result=[]
    for row in rows[:10]:
        if not isinstance(row,dict):continue
        try:
            lon,lat = map(float,str(row.get("location","")).split(","))
            if not math.isfinite(lat) or not math.isfinite(lon) or not -90<=lat<=90 or not -180<=lon<=180:continue
        except (ValueError,TypeError):continue
        text=lambda key: str(row[key])[:300] if isinstance(row.get(key),str) else ""
        if not text("name"):continue
        result.append({"poi_id":text("id")[:128],"name":text("name")[:120],"address":text("address"),"city":text("cityname"),"latitude":lat,"longitude":lon,"coordinate_type":"gcj02"})
    return result

async def search_places(hass, key, keywords, city=""):
    from homeassistant.helpers.aiohttp_client import async_get_clientsession
    params=search_params(key,keywords,city)
    try:
        async with asyncio.timeout(10):
            async with async_get_clientsession(hass).get("https://restapi.amap.com/v3/place/text",params=params,allow_redirects=False) as response:
                if response.status != 200:raise ValueError("高德服务暂不可用")
                # 固定域名与有限结果；异常绝不回传含 Key 的请求 URL。
                data=await response.json()
    except Exception:
        raise ValueError("高德服务连接失败，请稍后重试") from None
    return parse_places(data)
