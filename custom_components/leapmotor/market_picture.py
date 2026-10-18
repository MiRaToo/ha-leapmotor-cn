"""Official public mall vehicle renders, including retained legacy listings.

The mall home page only exposes a subset of the configurations still served by
its product APIs. We use the current V4 feed first, then the legacy product
feed for older model years and models omitted from the home-page carousel.
"""
from functools import lru_cache
import re
import time
from urllib.parse import urlsplit, parse_qs, urlencode
from urllib.request import urlopen

CATALOG_URL = "https://ueapp.oss-cn-hangzhou.aliyuncs.com/nativeApp/loveCar/love_car_default_header.txt"
MARKET_BASE = "https://carod-center.leapmotor.cn"
CONFIG_PAGE_BASE = "https://www-app.leapmotor.com"
COMMUNITY_BASE = "https://apptec.leapmotor.cn"
IMAGE_HOSTS = {
    "lpmall-dop-prod.oss-cn-hangzhou.aliyuncs.com",
    "ueapp-oss-static.leapmotor.com",
    "ueapp-oss-static.leapmotor.cn",
    "lp-website-oss-static.leapmotor.com",
}

# Official legacy configurator pages are a separate provider from both mall
# feeds. Keep verified route metadata here; the adapter itself is model- and
# year-agnostic so adding another confirmed route needs data, not new logic.
CONFIG_PAGE_ROUTES = (
    {"model": "C11", "year": "2023", "code": "C11-230801", "energy": "纯电"},
)

# These older model aliases are still accepted by the public resource lookup,
# even though they are no longer present in the current home-page catalogue.
# Unavailable aliases (for example S01 today) are omitted after lookup.
LEGACY_MODEL_ALIASES = ("C01", "T03", "Lafa5", "S01")
KNOWN_BEV_MODELS = {"A05", "A10", "B01", "B10", "T03", "LAFA5"}


@lru_cache(maxsize=256)
def _read(url, bucket):
    with urlopen(url, timeout=12) as response:
        import json
        return json.loads(response.read(4_000_000))


def _configuration_code(row):
    for action in row.get("actionButtons", []):
        url = urlsplit(action.get("jumpUrl") or "")
        if url.scheme == "https" and url.hostname == "www-app.leapmotor.cn" and url.path == "/configuration-v4.html":
            return (parse_qs(url.query).get("carCode") or [""])[0]
    return ""


def catalogue_code(catalog, model):
    wanted = str(model or "").strip().upper()
    for row in catalog.get("carIntroduction", []):
        if str(row.get("carName", "")).strip().upper() != wanted:
            continue
        code = _configuration_code(row)
        if code:
            return code
    return ""


def catalogue_models(catalog):
    """Return home-page models whose configuration link points to Leapmotor."""
    out = []
    seen = set()
    for row in catalog.get("carIntroduction", []):
        name = str(row.get("carName") or "").strip()
        code = _configuration_code(row)
        if not name or not code or name.casefold() in seen:
            continue
        seen.add(name.casefold())
        out.append({"name": name, "code": code})
    return out


def _reader(read):
    bucket = int(time.time() // 3600)
    return read or (lambda url: _read(url, bucket))


def _resource_car_type(code, read):
    if not code:
        return ""
    # New mall deployments use carod-center; older official site pages use
    # the community resource directory. Resolve the resource through both
    # before treating the supplied model/code itself as a carType.
    lookups = (
        (MARKET_BASE, "/mallResourceConfig/getByCode"),
        (COMMUNITY_BASE, "/app-community/resourceConfig/getByCode"),
    )
    for base, path in lookups:
        try:
            response = read(base + path + "?" + urlencode({"code": code}))
        except Exception:
            continue
        data = (response.get("data") or {}) if isinstance(response, dict) else {}
        if isinstance(data, dict) and data.get("carType"):
            return str(data["carType"])
    return ""


def _energy(specs="", vehicle_type="", hint=""):
    type_text = str(vehicle_type or "").strip().upper()
    text = " ".join(str(value or "") for value in (specs, vehicle_type)).upper()
    if "增程" in text or "REEV" in text:
        return "增程"
    if "纯电" in text or "BEV" in text:
        return "纯电"
    if hint in ("增程", "纯电"):
        return hint
    # The mall omits vehicleSpecs for several all-electric series. Infer BEV
    # only for the known series; leave future/unknown models unclassified.
    return "纯电" if type_text in KNOWN_BEV_MODELS else ""


def _year_from_image(row):
    for key in ("carTypeImgsDemo", "carTypeImgs"):
        match = re.search(r"(?:^|/)(20\d{2})[_-]", str(row.get(key) or ""))
        if match:
            return match.group(1)
    return ""


def _variant(row, source, energy_hint=""):
    model_id = str(
        row.get("carModel") or row.get("skuVersion") or row.get("skuCode")
        or row.get("vehicleCode") or (row.get("carType") if source == "legacy_sale" else "") or ""
    ).strip()
    year = str(row.get("vehicleYear") or row.get("carYear") or row.get("year") or "").strip()
    year = year or _year_from_image(row)
    if not year:
        match = re.search(r"(?:^|\D)(20\d{2})(?:\D|$)", model_id)
        year = match.group(1) if match else ""
    edition = str(
        row.get("vehicleModel") or row.get("carName") or row.get("versionName")
        or row.get("editionName") or row.get("name") or ""
    ).strip()
    if not model_id or not year or not edition:
        return None
    energy = _energy(row.get("vehicleSpecs"), row.get("vehicleType") or row.get("carName"), energy_hint)
    if not energy:
        return None
    return {
        "id": model_id,
        "year": year,
        "energy": energy,
        "edition": edition,
        "source": source,
    }


def _legacy_rows(payload):
    data = payload.get("data") or []
    if not isinstance(data, list):
        return []
    out = []
    for group in data:
        if not isinstance(group, dict):
            continue
        for key, rows in group.items():
            if not isinstance(rows, list):
                continue
            hint = "增程" if "extend" in key.casefold() else "纯电" if "pure" in key.casefold() else ""
            out.extend((row, hint) for row in rows if isinstance(row, dict) and row.get("carModel"))
    return out


def _legacy_sale_rows(payload):
    """Flatten edition payloads returned by the retired official sale API."""
    data = payload.get("data") if isinstance(payload, dict) else None
    rows = []
    id_fields = ("carModel", "skuVersion", "skuCode", "vehicleCode", "carType")
    name_fields = ("vehicleModel", "carName", "versionName", "editionName", "name")

    def collect(value, hint=""):
        if isinstance(value, list):
            for item in value:
                collect(item, hint)
            return
        if not isinstance(value, dict):
            return
        if any(value.get(key) for key in id_fields) and any(value.get(key) for key in name_fields):
            rows.append((value, hint))
            return
        for key, nested in value.items():
            key_text = key.casefold()
            child_hint = "增程" if "extend" in key_text or "reev" in key_text else (
                "纯电" if "pure" in key_text or "bev" in key_text else hint
            )
            if isinstance(nested, (list, dict)):
                collect(nested, child_hint)

    collect(data)
    return rows


def _configuration_page_rows(model, read, year=None):
    """Return trims from verified official legacy configurator routes."""
    model_key = str(model or "").strip().upper()
    out = []
    for route in CONFIG_PAGE_ROUTES:
        if route["model"].upper() != model_key or (year and str(route["year"]) != str(year)):
            continue
        year, code = str(route["year"]), route["code"]
        try:
            payload = read(CONFIG_PAGE_BASE + "/vehicleMatching/getVehicleConfig?" + urlencode({"carType": code}))
        except Exception:
            continue
        data = payload.get("data") or {}
        if not isinstance(data, dict):
            continue
        for row in data.values():
            if not isinstance(row, dict):
                continue
            model_id = str(row.get("carType") or "").strip()
            car_name = str(row.get("carName") or "").strip()
            if not model_id or not car_name:
                continue
            prefix = model_key + " "
            edition = car_name[len(prefix):].strip() if car_name.upper().startswith(prefix) else car_name
            if not edition:
                continue
            out.append(({
                "id": model_id,
                "year": str(year),
                "energy": route.get("energy") or "",
                "edition": edition,
                "source": "configuration_page",
                "config_code": code,
                "model": model_key,
            }, row))
    return out


def _configuration_page_product(model_id, route, read):
    """Translate a historical official trim into the common product shape."""
    config_code = route["code"]
    try:
        payload = read(CONFIG_PAGE_BASE + "/vehicleMatching/getVehicleConfig?" + urlencode({"carType": config_code}))
    except Exception:
        return {}
    data = payload.get("data") or {}
    if not isinstance(data, dict):
        return {}
    row = data.get(str(model_id))
    if not isinstance(row, dict):
        row = next((value for value in data.values()
                    if isinstance(value, dict) and str(value.get("carType") or "") == str(model_id)), None)
    if not isinstance(row, dict):
        return {}
    colors = []
    for item in row.get("outColor") or []:
        if not isinstance(item, dict):
            continue
        colors.append({
            "color": item.get("color"),
            "appearanceCarImgs": (
                item.get("appearanceCarImgs") or item.get("slideshowImgsPc")
                or item.get("slideshowImgsH5") or item.get("image")
            ),
        })
    car_name = str(row.get("carName") or "").strip()
    prefix = route["model"].upper() + " "
    edition = car_name[len(prefix):].strip() if car_name.upper().startswith(prefix) else car_name
    return {
        "vehicleYear": str(route["year"]),
        "vehicleModel": edition,
        "outColor": colors,
    }


def _configuration_route(config_code):
    code = str(config_code or "")
    return next((route for route in CONFIG_PAGE_ROUTES if route["code"] == code), None)


def _variants_for_model(model, read, catalog=None, year=None):
    """Merge all supported official feeds into one canonical variant list.

    Provider precedence is V4, legacy mall list, then verified legacy
    configurator. Each provider contributes the same {id, year, energy,
    edition, source} shape, and exact year matching happens only after merge.
    """
    if not model:
        return [], False
    if catalog is None:
        try:
            catalog = read(CATALOG_URL)
        except Exception:  # a legacy alias can still work when the carousel is down
            catalog = {}
    requested_year = str(year or "").strip()
    if requested_year:
        # The public site uses this code form for year-specific pages. Probe it
        # only when the user selects that year, so opening settings stays fast.
        codes = [requested_year + str(model).strip()]
    else:
        codes = []
        current = catalogue_code(catalog, model)
        if current:
            codes.append(current)
        codes.append(str(model).strip())

    found_resource = False
    variants = {}
    for code in dict.fromkeys(codes):
        try:
            car_type = _resource_car_type(code, read)
        except Exception:
            continue
        provider_code = car_type or (code if requested_year else "")
        before = (sum(item["year"] == requested_year for item in variants.values())
                  if requested_year else len(variants))
        if car_type:
            found_resource = True
            query = urlencode({"carType": car_type, "platform": 3})
            try:
                data = read(MARKET_BASE + "/vehicleProduct/getVehicleModelSeatListV4?" + query).get("data") or {}
                for row in (data.get("modelList") or []) if isinstance(data, dict) else []:
                    item = _variant(row, "v4")
                    if item:
                        variants[item["id"]] = item
            except Exception:
                pass
            try:
                payload = read(MARKET_BASE + "/vehicleProduct/getVehicleModelSeatList?" + urlencode({"carType": car_type}))
                for row, hint in _legacy_rows(payload):
                    item = _variant(row, "legacy", hint)
                    if item and item["id"] not in variants:
                        variants[item["id"]] = item
            except Exception:
                pass
        # Some retired site builds call the sale edition API directly with the
        # resource code. Try it only as a fallback, never mixing its products
        # into a year unless the row itself identifies that year.
        after = (sum(item["year"] == requested_year for item in variants.values())
                 if requested_year else len(variants))
        if provider_code and after == before:
            try:
                payload = read(MARKET_BASE + "/vehicleSaleConfig/getSaleVehicleEdition?"
                              + urlencode({"carType": provider_code}))
                for row, hint in _legacy_sale_rows(payload):
                    item = _variant(row, "legacy_sale", hint)
                    if item and item["id"] not in variants:
                        variants[item["id"]] = item
                if len(variants) > before:
                    found_resource = True
            except Exception:
                pass
    for item, _row in _configuration_page_rows(model, read, requested_year or None):
        if requested_year and item["year"] != requested_year:
            continue
        if item["id"] not in variants:
            variants[item["id"]] = item
    result = list(variants.values())
    if requested_year:
        result = [item for item in result if item["year"] == requested_year]
    result.sort(key=lambda item: (item["year"], item["energy"], item["edition"], item["id"]), reverse=True)
    return result, found_resource


def fetch_market_catalog(read=None):
    """List current public models plus older aliases that still have trims."""
    read = _reader(read)
    try:
        catalog = read(CATALOG_URL)
    except Exception:
        catalog = {}
    models = catalogue_models(catalog)
    seen = {item["name"].casefold() for item in models}
    for name in LEGACY_MODEL_ALIASES:
        if name.casefold() in seen:
            continue
        variants, _ = _variants_for_model(name, read, catalog)
        if variants:
            models.append({"name": name, "code": name})
            seen.add(name.casefold())
    return {"models": models, "source": "official_market"} if models else {
        "models": [], "reason": "商城目录暂未提供可选车型"
    }


def fetch_market_variants(model, read=None, year=None):
    """Read current and retained historical years/configurations for a model."""
    if not model:
        return {"variants": [], "reason": "请先选择车型"}
    read = _reader(read)
    variants, found_resource = _variants_for_model(model, read, year=year)
    if variants:
        return {"model": str(model), "variants": [
            {key: item[key] for key in ("id", "year", "energy", "edition")}
            for item in variants
        ], "source": "official_market"}
    reason = (
        f"官方配置源没有匹配 {year} 款 {model}（不会以其他年款代替）"
        if year else "该车型暂无可用年款或配置" if found_resource else "公开目录没有此车型配置页"
    )
    return {"model": str(model), "variants": [], "reason": reason}


def choose_model(models, model, year, reev, edition="", model_id=""):
    rows = []
    for row in models.get("modelList", []):
        if str(row.get("vehicleYear") or "") != str(year):
            continue
        row_type = str(row.get("vehicleType") or "").replace("增程", "").strip().upper()
        if row_type and row_type != str(model).upper():
            continue
        wanted_energy = "增程" if reev else "纯电"
        if _energy(row.get("vehicleSpecs"), row.get("vehicleType")) != wanted_energy:
            continue
        if edition and str(row.get("vehicleModel") or "").strip() != str(edition).strip():
            continue
        if model_id and str(row.get("carModel")) != str(model_id):
            continue
        rows.append(row)
    return rows[0] if rows else None


def picture_from_product(product, color=""):
    rows = pictures_from_product(product)
    if color:
        rows = [row for row in rows if row["color"] == color]
    if not rows:
        return {}
    return {
        **rows[0],
        "year": product.get("vehicleYear"),
        "edition": product.get("vehicleModel"),
        "source": "official_market",
    }


def pictures_from_product(product):
    """Return official full-car render colors; discard untrusted image hosts."""
    out = []
    seen = set()
    for row in product.get("outColor") or []:
        if not isinstance(row, dict):
            continue
        color = str(row.get("color") or "").strip()
        url = str(
            row.get("appearanceCarImgs") or row.get("slideshowImgsPc")
            or row.get("slideshowImgsH5") or row.get("image") or ""
        )
        parsed = urlsplit(url)
        if not color or color in seen or parsed.scheme != "https" or parsed.hostname not in IMAGE_HOSTS:
            continue
        seen.add(color)
        out.append({"color": color, "url": url})
    return out


def _product_config(model_id, source, read, config_code=""):
    if source == "configuration_page":
        route = _configuration_route(config_code)
        return _configuration_page_product(model_id, route, read) if route else {}
    if source == "legacy_sale":
        try:
            response = read(MARKET_BASE + "/vehicleSaleConfig/getSaleVehicleConfig?"
                            + urlencode({"carType": model_id}))
            product = response.get("data") if isinstance(response, dict) else None
            if isinstance(product, dict) and (product.get("outColor") or product.get("vehicleYear")):
                return product
        except Exception:
            pass
    endpoints = ["getVehicleProductConfigV4", "getVehicleProductConfig"]
    if source == "legacy":
        endpoints.reverse()
    for endpoint in endpoints:
        try:
            response = read(MARKET_BASE + "/vehicleProduct/" + endpoint + "?" + urlencode({"carType": model_id}))
            product = response.get("data") or {}
            if isinstance(product, dict) and (product.get("vehicleYear") or product.get("outColor")):
                return product
        except Exception:
            continue
    return {}


def _product_for_model(model, year, *, reev=False, edition="", model_id="", read=None):
    if not model or not year:
        return None, "年款未知，不使用在售款代替"
    read = _reader(read)
    variants, _ = _variants_for_model(model, read)
    wanted_energy = "增程" if reev else "纯电"
    chosen = None
    def find_variant(rows):
        return next((variant for variant in rows
                     if (not model_id or variant["id"] == str(model_id))
                     and variant["year"] == str(year)
                     and variant["energy"] == wanted_energy
                     and (not edition or variant["edition"] == str(edition).strip())), None)

    chosen = find_variant(variants)
    if not chosen:
        year_variants, _ = _variants_for_model(model, read, year=year)
        chosen = find_variant(year_variants)
    if not chosen:
        if model_id:
            return None, "官方配置已变化，请重新选择车型版本"
        edition_text = f"、{edition}" if edition else ""
        return None, f"官方配置源没有匹配 {year} 款 {model}{edition_text}（不会以其他年款代替）"
    product = _product_config(chosen["id"], chosen["source"], read, chosen.get("config_code", ""))
    if not product:
        return None, "商城配置暂时无法读取"
    product_year = str(product.get("vehicleYear") or chosen["year"])
    if product_year != str(year):
        return None, "商城配置年款不一致"
    if edition and str(product.get("vehicleModel") or "").strip() != str(edition).strip():
        return None, "商城配置版本不一致"
    return product, ""


def fetch_market_pictures(model, year, *, reev=False, edition="", model_id="", read=None):
    """Read exact official color renders, with legacy product-config fallback."""
    product, reason = _product_for_model(model, year, reev=reev, edition=edition, model_id=model_id, read=read)
    if not product:
        return {"reason": reason}
    pictures = pictures_from_product(product)
    if not pictures:
        return {"reason": "该商城配置没有可用的官方整车渲染图"}
    return {
        "pictures": pictures,
        "year": product.get("vehicleYear"),
        "edition": product.get("vehicleModel"),
        "source": "official_market",
    }


def fetch_market_picture(model, year, *, reev=False, color="", edition="", read=None):
    result = fetch_market_pictures(model, year, reev=reev, edition=edition, read=read)
    if not result.get("pictures"):
        return result
    selected = next((picture for picture in result["pictures"] if not color or picture["color"] == color), None)
    if not selected:
        return {"reason": "没有匹配颜色的整车渲染图"}
    return {**selected, "year": result["year"], "edition": result["edition"], "source": result["source"]}
