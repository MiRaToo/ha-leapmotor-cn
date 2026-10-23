import sys
import io
import ssl
from threading import Barrier
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "custom_components" / "leapmotor"))

from market_picture import (  # noqa: E402
    catalogue_code,
    catalogue_models,
    choose_model,
    fetch_market_catalog,
    fetch_market_picture,
    fetch_market_pictures,
    fetch_market_variants,
    picture_from_product,
)
import market_picture  # noqa: E402


def test_market_reads_reuse_ipv4_first_transport_and_cache(monkeypatch):
    calls = []

    class Opener:
        def open(self, url, *, timeout):
            calls.append((url, timeout))
            return io.BytesIO(b'{"data": {"carType": "C10"}}')

    def build(context):
        assert context.check_hostname
        assert context.verify_mode == ssl.CERT_REQUIRED
        return Opener()

    monkeypatch.setattr(market_picture, "_build_opener", build)
    market_picture._read.cache_clear()
    try:
        url = market_picture.MARKET_BASE + "/mallResourceConfig/getByCode?code=C10"
        assert market_picture._read(url, 1) == {"data": {"carType": "C10"}}
        assert market_picture._read(url, 1) == {"data": {"carType": "C10"}}
        assert calls == [(url, 12)]
    finally:
        market_picture._read.cache_clear()


def test_legacy_catalog_lookups_run_concurrently_and_preserve_model_order(monkeypatch):
    ready = Barrier(len(market_picture.LEGACY_MODEL_ALIASES))

    def variants(model, read, catalog):
        ready.wait(timeout=5)
        return ([{"id": model}] if model != "S01" else []), True

    monkeypatch.setattr(market_picture, "_variants_for_model", variants)
    result = fetch_market_catalog(read=lambda _url: {"carIntroduction": []})
    assert [row["name"] for row in result["models"]] == ["C01", "T03", "Lafa5"]


CAT = {"carIntroduction": [{
    "carName": "C10",
    "actionButtons": [{"jumpUrl": "https://www-app.leapmotor.cn/configuration-v4.html?carCode=2027C10"}],
}]}
MODELS = {"modelList": [
    {"vehicleYear": "2027", "vehicleType": "C10", "vehicleSpecs": "纯电", "vehicleModel": "660版", "carModel": "v4-ev"},
    {"vehicleYear": "2027", "vehicleType": "C10增程", "vehicleSpecs": "增程", "vehicleModel": "290版", "carModel": "v4-reev"},
]}
LEGACY_C10 = {"data": [{
    "pureEVList": [{
        "vehicleType": "C10", "vehicleModel": "605悦享版", "carModel": "C10-250512-C10-0020",
        "carTypeImgsDemo": "https://lpmall-dop-prod.oss-cn-hangzhou.aliyuncs.com/material/2026_C10/yx.png",
    }],
    "extendList": [{
        "vehicleType": "C10增程", "vehicleModel": "210悦享版", "carModel": "C10-250512-C10-0040",
        "carTypeImgsDemo": "https://lpmall-dop-prod.oss-cn-hangzhou.aliyuncs.com/material/2026_C10/reev.png",
    }],
}]}
LEGACY_C01 = {"data": [{"pureEVList": [{
    "vehicleType": "C01", "vehicleModel": "525舒享版", "carModel": "C01-240719-C01-0100",
    "carTypeImgsDemo": "https://lpmall-dop-prod.oss-cn-hangzhou.aliyuncs.com/material/2024_C01_Optional/EV.png",
}]}]}
PRODUCT_2027 = {"vehicleYear": "2027", "vehicleModel": "660版", "outColor": [
    {"color": "灰", "appearanceCarImgs": "https://lpmall-dop-prod.oss-cn-hangzhou.aliyuncs.com/gray-2027.png"},
]}
PRODUCT_2026 = {"vehicleYear": "2026", "vehicleModel": "605悦享版", "outColor": [
    {"color": "曦露紫", "appearanceCarImgs": "https://lpmall-dop-prod.oss-cn-hangzhou.aliyuncs.com/gray-2026.png"},
    {"color": "珍珠白", "appearanceCarImgs": "https://ueapp-oss-static.leapmotor.com/white-2026.png"},
]}
CONFIG_PAGE_C11_2023 = {"data": {
    "C11500Comfort": {
        "carType": "C11500Comfort", "carName": "C11 500舒享版", "outColor": [
            {"color": "天幕灰", "slideshowImgsPc": "https://lp-website-oss-static.leapmotor.com/reserve-config/C11-2023/pc/outward/18/backdrop-gray.png"},
            {"color": "光白", "slideshowImgsPc": "https://lp-website-oss-static.leapmotor.com/reserve-config/C11-2023/pc/outward/18/light-white.png"},
        ],
    },
    "C11500Smart": {"carType": "C11500Smart", "carName": "C11 500智享版", "outColor": []},
    "C11650Smart": {"carType": "C11650Smart", "carName": "C11 650智享版", "outColor": []},
    "C11580Properties": {"carType": "C11580Properties", "carName": "C11 580四驱性能版", "outColor": []},
}}


def c10_read(calls=None):
    """Small fixture for the current V4 and retained legacy C10 endpoints."""
    calls = calls if calls is not None else []

    def read(url):
        calls.append(url)
        parsed = urlsplit(url)
        query = parse_qs(parsed.query)
        if "header.txt" in url:
            return CAT
        if parsed.path.endswith("/mallResourceConfig/getByCode"):
            code = query.get("code", [""])[0]
            if code == "2027C10":
                return {"data": {"carType": "current-c10"}}
            if code == "C10":
                return {"data": {"carType": "legacy-c10"}}
            return {"data": None}
        if parsed.path.endswith("/app-community/resourceConfig/getByCode"):
            return {"data": None}
        car_type = query.get("carType", [""])[0]
        if parsed.path.endswith("getSaleVehicleEdition"):
            return {"data": []}
        if parsed.path.endswith("getSaleVehicleConfig"):
            return {"data": None}
        if parsed.path.endswith("getVehicleModelSeatListV4"):
            return {"data": MODELS if car_type == "current-c10" else {"modelList": []}}
        if parsed.path.endswith("getVehicleModelSeatList"):
            return LEGACY_C10 if car_type == "legacy-c10" else {"data": []}
        if parsed.path.endswith("getVehicleProductConfigV4"):
            return {"data": PRODUCT_2027 if car_type == "v4-ev" else {}}
        if parsed.path.endswith("getVehicleProductConfig"):
            return {"data": PRODUCT_2026 if car_type == "C10-250512-C10-0020" else {}}
        raise AssertionError(f"Unexpected market URL: {url}")

    return read


def test_exact_year_energy_and_edition_required():
    assert choose_model(MODELS, "C10", 2026, False) is None
    assert choose_model(MODELS, "C10", 2027, True)["carModel"] == "v4-reev"
    assert choose_model(MODELS, "C10", 2027, False, "不存在版") is None


def test_composite_or_missing_energy_is_normalized():
    rows = {"modelList": [
        {"vehicleYear": "2027", "vehicleType": "C16增程", "vehicleSpecs": "六座版|增程", "vehicleModel": "六座版", "carModel": "c16"},
        {"vehicleYear": "2027", "vehicleType": "B10", "vehicleSpecs": None, "vehicleModel": "510版", "carModel": "b10"},
    ]}
    assert choose_model(rows, "C16", 2027, True)["carModel"] == "c16"
    assert choose_model(rows, "B10", 2027, False)["carModel"] == "b10"


def test_variant_parser_keeps_composite_and_omitted_energy_rows():
    catalog = {"carIntroduction": [
        {"carName": "C16", "actionButtons": [{"jumpUrl": "https://www-app.leapmotor.cn/configuration-v4.html?carCode=2027C16"}]},
        {"carName": "B10", "actionButtons": [{"jumpUrl": "https://www-app.leapmotor.cn/configuration-v4.html?carCode=2027B10"}]},
    ]}

    def read(url):
        parsed = urlsplit(url)
        query = parse_qs(parsed.query)
        if "header.txt" in url:
            return catalog
        if parsed.path.endswith("/mallResourceConfig/getByCode"):
            code = query["code"][0]
            return {"data": {"carType": code}} if code in {"2027C16", "2027B10"} else {"data": None}
        if parsed.path.endswith("getVehicleModelSeatListV4"):
            if query["carType"][0] == "2027C16":
                rows = [{"vehicleYear": "2027", "vehicleType": "C16增程", "vehicleSpecs": "六座版|增程", "vehicleModel": "280版 六座", "carModel": "c16-reev"}]
            else:
                rows = [{"vehicleYear": "2027", "vehicleType": "B10", "vehicleSpecs": None, "vehicleModel": "540版", "carModel": "b10-bev"}]
            return {"data": {"modelList": rows}}
        if parsed.path.endswith("getVehicleModelSeatList"):
            return {"data": []}
        raise AssertionError(f"Unexpected market URL: {url}")

    c16 = fetch_market_variants("C16", read=read)["variants"]
    b10 = fetch_market_variants("B10", read=read)["variants"]
    assert c16 == [{"id": "c16-reev", "year": "2027", "energy": "增程", "edition": "280版 六座"}]
    assert b10 == [{"id": "b10-bev", "year": "2027", "energy": "纯电", "edition": "540版"}]


def test_catalog_merges_legacy_models_not_on_homepage():
    catalog = {"carIntroduction": [
        *CAT["carIntroduction"],
        {"carName": "C10", "actionButtons": [{"jumpUrl": "https://www-app.leapmotor.cn/configuration-v4.html?carCode=duplicate"}]},
        {"carName": "伪造车型", "actionButtons": [{"jumpUrl": "https://evil.example/configuration-v4.html?carCode=bad"}]},
    ]}
    assert catalogue_models(catalog) == [{"name": "C10", "code": "2027C10"}]
    calls = []

    def read(url):
        calls.append(url)
        parsed = urlsplit(url)
        query = parse_qs(parsed.query)
        if "header.txt" in url:
            return catalog
        if parsed.path.endswith("/mallResourceConfig/getByCode"):
            return {"data": {"carType": "legacy-c01"}} if query.get("code") == ["C01"] else {"data": None}
        if parsed.path.endswith("/app-community/resourceConfig/getByCode"):
            return {"data": None}
        if parsed.path.endswith("getVehicleModelSeatListV4"):
            return {"data": {"modelList": []}}
        if parsed.path.endswith("getVehicleModelSeatList"):
            return LEGACY_C01 if query.get("carType") == ["legacy-c01"] else {"data": []}
        return {"data": None}

    assert fetch_market_catalog(read=read)["models"] == [
        {"name": "C10", "code": "2027C10"}, {"name": "C01", "code": "C01"},
    ]
    assert len(calls) > 1


def test_variants_include_legacy_c10_2026_and_current_c10_2027():
    result = fetch_market_variants("C10", read=c10_read())
    assert {(item["year"], item["energy"], item["edition"]) for item in result["variants"]} == {
        ("2027", "增程", "290版"),
        ("2027", "纯电", "660版"),
        ("2026", "增程", "210悦享版"),
        ("2026", "纯电", "605悦享版"),
    }


def test_legacy_c10_2026_fetches_exact_color_renders():
    result = fetch_market_pictures(
        "C10", 2026, edition="605悦享版", model_id="C10-250512-C10-0020", read=c10_read(),
    )
    assert result["source"] == "official_market"
    assert result["year"] == "2026"
    assert result["pictures"] == [
        {"color": "曦露紫", "url": "https://lpmall-dop-prod.oss-cn-hangzhou.aliyuncs.com/gray-2026.png"},
        {"color": "珍珠白", "url": "https://ueapp-oss-static.leapmotor.com/white-2026.png"},
    ]


def test_c11_2023_configuration_page_adds_real_trim_options():
    def read(url):
        parsed = urlsplit(url)
        if parsed.hostname == "www-app.leapmotor.com" and parsed.path == "/vehicleMatching/getVehicleConfig":
            return CONFIG_PAGE_C11_2023
        if "header.txt" in url:
            return {"carIntroduction": []}
        if parsed.path.endswith("/mallResourceConfig/getByCode"):
            return {"data": None}
        if parsed.path.endswith("getVehicleModelSeatListV4") or parsed.path.endswith("getVehicleModelSeatList"):
            return {"data": {"modelList": []}}
        raise AssertionError(f"Unexpected market URL: {url}")

    result = fetch_market_variants("C11", read=read)
    assert {(item["id"], item["year"], item["energy"], item["edition"]) for item in result["variants"]} == {
        ("C11500Comfort", "2023", "纯电", "500舒享版"),
        ("C11500Smart", "2023", "纯电", "500智享版"),
        ("C11650Smart", "2023", "纯电", "650智享版"),
        ("C11580Properties", "2023", "纯电", "580四驱性能版"),
    }


def test_c11_2023_uses_exact_config_page_color_renders():
    def read(url):
        parsed = urlsplit(url)
        if parsed.hostname == "www-app.leapmotor.com" and parsed.path == "/vehicleMatching/getVehicleConfig":
            return CONFIG_PAGE_C11_2023
        if "header.txt" in url:
            return {"carIntroduction": []}
        if parsed.path.endswith("/mallResourceConfig/getByCode"):
            return {"data": None}
        if parsed.path.endswith("getVehicleModelSeatListV4") or parsed.path.endswith("getVehicleModelSeatList"):
            return {"data": {"modelList": []}}
        raise AssertionError(f"Unexpected market URL: {url}")

    result = fetch_market_pictures("C11", 2023, edition="500舒享版", model_id="C11500Comfort", read=read)
    assert result["year"] == "2023"
    assert result["edition"] == "500舒享版"
    assert result["pictures"] == [
        {"color": "天幕灰", "url": "https://lp-website-oss-static.leapmotor.com/reserve-config/C11-2023/pc/outward/18/backdrop-gray.png"},
        {"color": "光白", "url": "https://lp-website-oss-static.leapmotor.com/reserve-config/C11-2023/pc/outward/18/light-white.png"},
    ]


def test_community_resource_directory_is_used_when_mall_directory_has_no_code():
    calls = []

    def read(url):
        calls.append(url)
        parsed = urlsplit(url)
        query = parse_qs(parsed.query)
        if "header.txt" in url:
            return {"carIntroduction": []}
        if parsed.path.endswith("/mallResourceConfig/getByCode"):
            return {"data": None}
        if parsed.path.endswith("/app-community/resourceConfig/getByCode"):
            return {"data": {"carType": "community-c01"}} if query.get("code") == ["C01"] else {"data": None}
        if parsed.path.endswith("getVehicleModelSeatListV4"):
            return {"data": {"modelList": []}}
        if parsed.path.endswith("getVehicleModelSeatList"):
            return LEGACY_C01 if query.get("carType") == ["community-c01"] else {"data": []}
        raise AssertionError(f"Unexpected market URL: {url}")

    result = fetch_market_variants("C01", read=read)
    assert result["variants"] == [{
        "id": "C01-240719-C01-0100", "year": "2024", "energy": "纯电", "edition": "525舒享版",
    }]
    assert any("app-community/resourceConfig/getByCode?code=C01" in url for url in calls)


def test_year_specific_legacy_sale_api_is_normalized_to_common_variant_and_picture():
    catalog = {"carIntroduction": []}
    edition = {"data": [{
        "carType": "X992024EV", "vehicleType": "X99", "vehicleYear": "2024",
        "vehicleSpecs": "纯电", "vehicleModel": "500版",
    }]}
    product = {"data": {"vehicleYear": "2024", "vehicleModel": "500版", "outColor": [
        {"color": "白", "slideshowImgsPc": "https://lp-website-oss-static.leapmotor.com/x99/white.png"},
    ]}}

    def read(url):
        parsed = urlsplit(url)
        query = parse_qs(parsed.query)
        if "header.txt" in url:
            return catalog
        if parsed.path.endswith("/mallResourceConfig/getByCode") or parsed.path.endswith("/app-community/resourceConfig/getByCode"):
            return {"data": None}
        if parsed.path.endswith("getSaleVehicleEdition"):
            return edition if query.get("carType") == ["2024X99"] else {"data": []}
        if parsed.path.endswith("getSaleVehicleConfig"):
            return product if query.get("carType") == ["X992024EV"] else {"data": None}
        if parsed.path.endswith("getVehicleModelSeatListV4"):
            return {"data": {"modelList": []}}
        if parsed.path.endswith("getVehicleModelSeatList"):
            return {"data": []}
        raise AssertionError(f"Unexpected market URL: {url}")

    variants = fetch_market_variants("X99", read=read, year="2024")["variants"]
    assert variants == [{"id": "X992024EV", "year": "2024", "energy": "纯电", "edition": "500版"}]
    pictures = fetch_market_pictures("X99", 2024, edition="500版", model_id="X992024EV", read=read)
    assert pictures["pictures"] == [{
        "color": "白", "url": "https://lp-website-oss-static.leapmotor.com/x99/white.png",
    }]


def test_no_year_does_not_request_and_mismatched_trim_stops_before_product():
    calls = []
    read = c10_read(calls)
    assert not fetch_market_picture("C10", None, read=read).get("url") and calls == []
    result = fetch_market_pictures("C10", 2026, edition="605悦享版", model_id="changed-listing", read=read)
    assert result.get("reason") == "官方配置已变化，请重新选择车型版本"
    assert not any("getVehicleProductConfig" in url for url in calls)


def test_unavailable_c10_2024_is_not_substituted_with_another_year():
    result = fetch_market_pictures("C10", 2024, reev=False, read=c10_read())
    assert result == {"reason": "官方配置源没有匹配 2024 款 C10（不会以其他年款代替）"}


def test_catalogue_and_picture_reject_unapproved_hosts():
    assert catalogue_code({"carIntroduction": [{
        "carName": "C10", "actionButtons": [{"jumpUrl": "https://evil.example/configuration-v4.html?carCode=bad"}],
    }]}, "C10") == ""
    assert picture_from_product({"outColor": [{
        "color": "灰", "appearanceCarImgs": "http://127.0.0.1/a.png",
    }]}) == {}


def test_current_v4_photo_uses_selected_model_and_color():
    result = fetch_market_pictures("C10", 2027, edition="660版", model_id="v4-ev", read=c10_read())
    assert result["source"] == "official_market"
    assert result["pictures"] == [{
        "color": "灰", "url": "https://lpmall-dop-prod.oss-cn-hangzhou.aliyuncs.com/gray-2027.png",
    }]
    assert not picture_from_product({"vehicleYear": "2027", "vehicleModel": "660版", "outColor": [
        {"color": "灰", "appearanceCarImgs": "https://lpmall-dop-prod.oss-cn-hangzhou.aliyuncs.com/gray.png"},
    ]}, "红")
