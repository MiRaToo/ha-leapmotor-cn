"""车辆列表保留自有/共享来源，供配置流程和卡片展示。"""
import api_client


def test_vehicle_list_tags_owner_and_shared_and_deduplicates_vin():
    vehicles = api_client._extract_vehicles({"data": {
        "sharedcars": [
            {"vin": "VIN-A", "carType": "C10", "rightList": "110,170"},
            {"vin": "VIN-B", "carType": "B05"},
        ],
        "bindcars": [
            {"vin": "vin-a", "carType": "C10", "rightList": "110,170"},
        ],
    }})

    assert [(vehicle.vin, vehicle.source) for vehicle in vehicles] == [
        ("VIN-A", "owner"), ("VIN-B", "shared"),
    ]
    assert vehicles[0].can(110) and not vehicles[0].can(130)
