"""公开购车配置的整车渲染图。只跟随目录返回的版本，不猜车型代码或混用年款。"""
from functools import lru_cache
import json,time
from urllib.parse import urlsplit,parse_qs,urlencode
from urllib.request import urlopen

CATALOG_URL="https://ueapp.oss-cn-hangzhou.aliyuncs.com/nativeApp/loveCar/love_car_default_header.txt"
MARKET_BASE="https://carod-center.leapmotor.cn"
IMAGE_HOSTS={"lpmall-dop-prod.oss-cn-hangzhou.aliyuncs.com","ueapp-oss-static.leapmotor.com","ueapp-oss-static.leapmotor.cn"}

@lru_cache(maxsize=32)
def _read(url,bucket):
    with urlopen(url,timeout=12) as response:
        return json.loads(response.read(4_000_000))

def catalogue_code(catalog,model):
    for row in catalog.get("carIntroduction",[]):
        if str(row.get("carName","")).upper()!=model.upper():continue
        for action in row.get("actionButtons",[]):
            url=urlsplit(action.get("jumpUrl") or "")
            if url.scheme=="https" and url.hostname=="www-app.leapmotor.cn" and url.path=="/configuration-v4.html":
                return (parse_qs(url.query).get("carCode") or [""])[0]
    return ""

def choose_model(models,model,year,reev,edition=""):
    rows=[r for r in models.get("modelList",[]) if str(r.get("vehicleYear"))==str(year)
          and str(r.get("vehicleType","")).replace("增程","").upper()==model.upper()
          and r.get("vehicleSpecs")==("增程" if reev else "纯电")]
    if edition:rows=[r for r in rows if r.get("vehicleModel")==edition]
    return rows[0] if rows else None

def picture_from_product(product,color=""):
    rows=product.get("outColor") or []
    if color:rows=[r for r in rows if r.get("color")==color]
    for row in rows:
        url=str(row.get("appearanceCarImgs") or "")
        parsed=urlsplit(url)
        if parsed.scheme=="https" and parsed.hostname in IMAGE_HOSTS:
            return {"url":url,"color":row.get("color"),"year":product.get("vehicleYear"),"edition":product.get("vehicleModel"),"source":"official_market"}
    return {}

def fetch_market_picture(model,year,*,reev=False,color="",edition="",read=None):
    if not model or not year:return {"reason":"年款未知，不使用在售款代替"}
    bucket=int(time.time()//3600)
    read=read or (lambda url:_read(url,bucket))
    code=catalogue_code(read(CATALOG_URL),model)
    if not code:return {"reason":"公开目录没有此车型配置页"}
    resource=read(MARKET_BASE+"/mallResourceConfig/getByCode?"+urlencode({"code":code})).get("data") or {}
    if not resource.get("carType"):return {"reason":"公开车型映射未就绪"}
    models=read(MARKET_BASE+"/vehicleProduct/getVehicleModelSeatListV4?"+urlencode({"carType":resource["carType"],"platform":3})).get("data") or {}
    chosen=choose_model(models,model,year,reev,edition)
    if not chosen:return {"reason":"在售配置未匹配本车年款、能源类型或版本"}
    product=read(MARKET_BASE+"/vehicleProduct/getVehicleProductConfigV4?"+urlencode({"carType":chosen["carModel"]})).get("data") or {}
    if str(product.get("vehicleYear"))!=str(year):return {"reason":"商品配置年款不一致"}
    return picture_from_product(product,color) or {"reason":"没有匹配颜色的整车渲染图"}
