from market_picture import catalogue_code,choose_model,picture_from_product,fetch_market_picture

CAT={"carIntroduction":[{"carName":"C10","actionButtons":[{"jumpUrl":"https://www-app.leapmotor.cn/configuration-v4.html?carCode=2027C10"}]}]}
MODELS={"modelList":[{"vehicleYear":"2027","vehicleType":"C10","vehicleSpecs":"纯电","vehicleModel":"660版","carModel":"return-from-list"},{"vehicleYear":"2027","vehicleType":"C10增程","vehicleSpecs":"增程","vehicleModel":"290版","carModel":"reev-from-list"}]}
def test_exact_year_energy_and_edition_required():
    assert choose_model(MODELS,"C10",2026,False) is None
    assert choose_model(MODELS,"C10",2027,True)["carModel"]=="reev-from-list"
    assert choose_model(MODELS,"C10",2027,False,"不存在版") is None

def test_no_year_does_not_request_and_mismatch_stops_before_product():
    calls=[]
    def read(url):
        calls.append(url)
        return CAT if 'header.txt' in url else {"data":{"carType":"public-list"}} if 'getByCode' in url else {"data":MODELS}
    assert not fetch_market_picture("C10",None,read=read).get("url") and calls==[]
    assert not fetch_market_picture("C10",2026,read=read).get("url") and len(calls)==3

def test_catalogue_and_picture_reject_unapproved_hosts():
    assert catalogue_code({"carIntroduction":[{"carName":"C10","actionButtons":[{"jumpUrl":"https://evil.example/configuration-v4.html?carCode=bad"}]}]},"C10")==""
    assert picture_from_product({"outColor":[{"color":"灰","appearanceCarImgs":"http://127.0.0.1/a.png"}]})=={}

def test_public_flow_uses_returned_model_and_color_image():
    calls=[]
    product={"vehicleYear":"2027","outColor":[{"color":"灰","appearanceCarImgs":"https://lpmall-dop-prod.oss-cn-hangzhou.aliyuncs.com/whole-car.png"}]}
    def read(url):
        calls.append(url)
        return CAT if 'header.txt' in url else {"data":{"carType":"public-list"}} if 'getByCode' in url else {"data":MODELS} if 'SeatList' in url else {"data":product}
    result=fetch_market_picture("C10",2027,color="灰",read=read)
    assert result["source"]=="official_market" and 'return-from-list' in calls[-1]
    assert not picture_from_product(product,"红")
