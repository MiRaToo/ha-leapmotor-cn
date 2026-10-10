"""车辆外观图 URL 响应解析测试。"""

import api_client


def test_parse_car_picture_url_from_official_data():
    assert api_client.parse_car_picture_url({
        "data": {"shareBindUrl": "http://cdn.example/car.png"}
    }) == "https://cdn.example/car.png"


def test_parse_car_picture_url_accepts_documented_aliases_and_root_payload():
    assert api_client.parse_car_picture_url({
        "data": {"imageUrl": "https://cdn.example/car.png"}
    }) == "https://cdn.example/car.png"
    assert api_client.parse_car_picture_url({
        "picUrl": "https://cdn.example/car.png"
    }) == "https://cdn.example/car.png"


def test_parse_car_picture_url_ignores_invalid_or_non_url_values():
    assert api_client.parse_car_picture_url({"data": {"shareBindUrl": "file:///car.png"}}) == ""
    assert api_client.parse_car_picture_url(None) == ""
