"""**素材采集与诊断服务**(只读) —— 供车主协助核查车型素材。

为什么需要它:云端的车型素材(3D 模型包 / 2D 分层图包 / 外观图)都挂在
`carpicture/*/key?vin=...` 这类**只认 VIN** 的接口上, 车型由服务端按 VIN 推导,
**无法枚举其它车型** —— 所以"每个车型的素材"只能由**拥有一辆该车型的人**去取。
本服务让车主在 HA 里点一下就把自己那辆车的素材落到本地磁盘, 不必重新登录
(直接复用集成已有的会话)。

安全 / 边界:
  * **只读**:不调用任何车控指令, 只做 GET 与文件落盘;
  * 只写 `config/leapmotor-assets/`, 不碰其它目录;
  * 云端有风控(见 `code=1023`):请求之间节流, 命中即**停止且不重试**;
  * manifest 里**不写 VIN**(只留指纹), 素材本身也不含位置信息。

服务只读取素材相关接口, 并将报告或素材保存在 HA 本机。
"""
from __future__ import annotations

import asyncio
import json
import ssl
import time
import urllib.request
import zipfile
from io import BytesIO
from pathlib import Path
from typing import Any
from urllib.parse import urlencode
import logging

from homeassistant.core import HomeAssistant, ServiceCall, SupportsResponse
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import config_validation as cv
import voluptuous as vol

from . import api as _api
from . import car3d
from .const import DOMAIN
from .diag_redact import vin_fingerprint

log = logging.getLogger(__name__)

ASSETS_DIRNAME = "leapmotor-assets"
# 云端风控关键字(命中即停, 不重试)
RISK_KEYWORDS = ("1023", "频繁", "风控")
# 请求之间的最小间隔(秒): 探针实测 3 秒足够稳, 且不会触发风控
THROTTLE_S = 3.0


def _coordinator(hass: HomeAssistant, entry_id: str = "") -> Any:
    entries = hass.config_entries.async_entries(DOMAIN)
    if entry_id:
        entries = [e for e in entries if e.entry_id == entry_id]
    if not entries:
        raise HomeAssistantError("找不到零跑集成条目(先添加集成)")
    return (hass.data.get(DOMAIN) or {}).get(entries[0].entry_id)


def _risk_hit(obj: Any) -> bool:
    s = json.dumps(obj, ensure_ascii=False)
    return any(k in s for k in RISK_KEYWORDS)


def _fetch_zip(client: Any, vin: str, key: str) -> bytes:
    """按 key 取一个素材包(zip)。key 可以是 h5Key / srcKey / 2D 包的 key。"""
    params = {"vin": vin, "key": key}
    url = f"{_api.BASE_URL}{_api.API_PREFIX}v3/api/carpicture/key/package"
    headers = client.build_headers(params)
    url += "?" + urlencode(params)
    req = urllib.request.Request(url, headers=headers, method="GET")
    ctx = ssl.create_default_context()
    with _api._build_opener(ctx).open(req, timeout=90) as resp:  # noqa: SLF001
        return resp.read()


def _save_zip_meta(raw: bytes) -> dict:
    """zip 的条目清单(不落盘就能看出里面有什么)。"""
    try:
        z = zipfile.ZipFile(BytesIO(raw))
        names = z.namelist()
        return {"entries": len(names), "names": names[:200]}
    except Exception as err:  # noqa: BLE001
        return {"entries": 0, "note": f"不是 zip: {err}"}


def _collect_sync(client: Any, vin: str, dest: Path, want_h5: bool) -> dict:
    """阻塞式采集(在 executor 里跑):取 key → 下载各素材包 → 落盘 + manifest。"""
    dest.mkdir(parents=True, exist_ok=True)
    out: dict[str, Any] = {"dir": str(dest), "files": [], "keys": {}}
    steps: list[tuple[str, str]] = []   # (标签, key)

    # ① 3D key:给车型参数 + h5Key + srcKey
    key3d = client.car_call("v3/api/carpicture/3d/key", car3d.asset_params(client, vin),
                            method="GET")
    if _risk_hit(key3d):
        raise HomeAssistantError(f"云端风控命中(3d/key): {json.dumps(key3d, ensure_ascii=False)[:200]}")
    d3 = (key3d or {}).get("data") or {}
    model_param = d3.get("modelParam") or {}
    h5_key = str(d3.get("h5Key") or "")
    src_key = str(d3.get("srcKey") or "")
    out["keys"] = {"h5Key": h5_key, "srcKey": src_key}
    out["modelParam"] = model_param
    if src_key:
        steps.append(("model3d", src_key))
    if h5_key and want_h5:
        steps.append(("h5viewer", h5_key))

    time.sleep(THROTTLE_S)

    # ② 2D 外观图 + 2D 分层包 key
    pic = client.car_call("v3/api/carpicture/key", {"vin": vin}, method="GET")
    if _risk_hit(pic):
        raise HomeAssistantError(f"云端风控命中(carpicture/key): {json.dumps(pic, ensure_ascii=False)[:200]}")
    dp = (pic or {}).get("data") or {}
    pic_url = str(dp.get("shareBindUrl") or dp.get("url") or "")
    pic_key = str(dp.get("key") or "")
    out["keys"]["package2dKey"] = pic_key
    if pic_key:
        steps.append(("package2d", pic_key))

    # ③ 逐个下载(带节流)
    for label, key in steps:
        time.sleep(THROTTLE_S)
        raw = _fetch_zip(client, vin, key)
        meta = _save_zip_meta(raw)
        fn = f"{label}_{key[:24]}.zip"
        (dest / fn).write_bytes(raw)
        out["files"].append({"name": fn, "bytes": len(raw), **meta})

    # ④ 2D 整图(签名 OSS 直链, 不走签名头)
    if pic_url:
        time.sleep(THROTTLE_S)
        try:
            req = urllib.request.Request(pic_url, method="GET")
            ctx = ssl.create_default_context()
            with _api._build_opener(ctx).open(req, timeout=90) as resp:  # noqa: SLF001
                img = resp.read()
            ext = ".png" if img[:8] == b"\x89PNG\r\n\x1a\n" else ".jpg"
            fn = "carpicture" + ext
            (dest / fn).write_bytes(img)
            out["files"].append({"name": fn, "bytes": len(img)})
        except Exception as err:  # noqa: BLE001
            out["files"].append({"name": "carpicture", "error": str(err)[:120]})
    return out


async def _handle_collect(call: ServiceCall) -> dict:
    hass: HomeAssistant = call.hass
    coord = _coordinator(hass, str(call.data.get("entry_id") or ""))
    if coord is None:
        raise HomeAssistantError("集成尚未就绪(等它连上后再试)")
    vin = str(getattr(coord, "vin", "") or "")
    if not vin:
        raise HomeAssistantError("读不到 VIN, 无法采集")

    client = coord.client
    st = getattr(coord, "state", None)
    car_type = str(getattr(coord.session, "car_type", "") or "")
    sub_version = str((coord.entry.data or {}).get("sub_version") or "")

    dest_root = Path(hass.config.path(ASSETS_DIRNAME))
    # 目录名先占位, 拿到 modelParam 后再定(车型_年份)
    res = await hass.async_add_executor_job(
        _collect_sync, client, vin, dest_root / f"_tmp_{car_type or 'unknown'}",
        bool(call.data.get("include_h5", False)),
    )
    mp = res.get("modelParam") or {}
    folder = f"{mp.get('carType') or car_type or 'unknown'}_{mp.get('year') or 'na'}"
    final = dest_root / folder
    # 改名到 车型_年份(已存在则合并)
    tmp = Path(res["dir"])
    if tmp != final:
        final.mkdir(parents=True, exist_ok=True)
        for f in tmp.iterdir():
            f.replace(final / f.name)
        try:
            tmp.rmdir()
        except OSError:
            pass

    manifest = {
        "car_type": car_type,
        "modelParam": mp,
        "vin_fingerprint": vin_fingerprint(vin),
        "sub_version": sub_version,
        "keys": res.get("keys"),
        "files": res.get("files"),
        "collected_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "note": "云端素材版权归零跑; 本目录仅本地留档, 不随仓库分发。",
    }
    (final / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    log.info("素材采集完成 → %s(%d 个文件)", final, len(res.get("files") or []))
    return {"dir": str(final), **manifest}


async def _handle_car3d_probe(call: ServiceCall) -> dict:
    """3D 素材**深度探针**(只读)。

    3D 素材的两类失败只在个别车型上出现("3dkey 响应异常" / "file is not a zip"),
    本地无法复现 —— 这个服务把该车链路上的**云端响应形状**一次记清:
    3d/key 的完整响应、两个素材包的状态码/内容类型/字节数/头部、以及 2D 外观图接口。
    报告落到 `config/leapmotor-assets/car3d-diag/`(不写 VIN、不写完整 key), 可直接转发。
    """
    hass: HomeAssistant = call.hass
    coord = _coordinator(hass, str(call.data.get("entry_id") or ""))
    if coord is None:
        raise HomeAssistantError("集成尚未就绪(等它连上后再试)")
    vin = str(getattr(coord, "vin", "") or "")
    if not vin:
        raise HomeAssistantError("读不到 VIN, 无法探测")

    state = getattr(coord, "state", None)
    signals = dict(getattr(state, "signals", None) or {})
    base = car3d.root(hass)
    st = (hass.data.get(DOMAIN) or {}).get(car3d.STATE_KEY) or {}
    extra = car3d.probe_extra(
        integration_version=_manifest_version(),
        car_type=str((coord.entry.data or {}).get("car_type") or ""),
        sub_version=str((coord.entry.data or {}).get("sub_version") or ""),
        vin_fingerprint=vin_fingerprint(vin),
        ready=await hass.async_add_executor_job(car3d.ready, base),
        status=await hass.async_add_executor_job(car3d.status, base),
        state=st,
        energy_pref=getattr(coord, "energy_pref", lambda: "")(),
        latched=bool(getattr(coord, "reev", False)),
        signals=signals,
    )

    dest = Path(hass.config.path(ASSETS_DIRNAME)) / "car3d-diag"
    report = await hass.async_add_executor_job(
        lambda: car3d.probe_sync(coord.client, vin, dest, extra=extra,
                                 deep=bool(call.data.get("deep", False)),
                                 variants=bool(call.data.get("variants", True)))
    )
    log.info("3D 素材探针完成 → %s(%d 个请求)", dest, report.get("requests"))
    return {"dir": str(dest), **report}


def _manifest_version() -> str:
    try:
        p = Path(__file__).with_name("manifest.json")
        return str(json.loads(p.read_text(encoding="utf-8")).get("version") or "")
    except Exception:  # noqa: BLE001
        return ""


async def async_register_asset_services(hass: HomeAssistant) -> None:
    """注册素材采集与诊断服务(幂等)。"""
    if not hass.services.has_service(DOMAIN, "collect_assets"):

        async def _svc(call: ServiceCall) -> dict:
            return await _handle_collect(call)

        hass.services.async_register(
            DOMAIN,
            "collect_assets",
            _svc,
            schema=vol.Schema({
                vol.Optional("entry_id"): cv.string,
                vol.Optional("include_h5", default=False): cv.boolean,
            }),
            supports_response=SupportsResponse.ONLY,
        )
    if not hass.services.has_service(DOMAIN, "car3d_probe"):

        async def _probe(call: ServiceCall) -> dict:
            return await _handle_car3d_probe(call)

        hass.services.async_register(
            DOMAIN,
            "car3d_probe",
            _probe,
            schema=vol.Schema({
                vol.Optional("entry_id"): cv.string,
                vol.Optional("deep", default=False): cv.boolean,
                vol.Optional("variants", default=True): cv.boolean,
            }),
            supports_response=SupportsResponse.ONLY,
        )
