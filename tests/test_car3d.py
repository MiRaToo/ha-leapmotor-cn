"""3D 车模素材装配: 懒下载 / 幂等 / 防越界解压 / 色表解析 —— 纯逻辑离线测试。

这里的每条都对应一个"会真的弄坏用户机器或白跑云端请求"的点:
  * 幂等: 卡片每次打开都会调 ensure —— 已装配好就**一个请求都不能发**(风控红线);
  * 冷却: 装配失败后一段时间内不再自动重试(避免失败循环刷云端);
  * 解压: 素材包是外部输入, 必须挡掉 `..`/绝对路径/symlink(防目录穿越);
  * 色表: 只认有 id_TSP 的行(那才是云端会下发的颜色码), 空行的颜色在 App 里也不可选;
  * 包装页版本: 升级只重铺包装页, **不重下模型**(十几 MB)。
"""
from __future__ import annotations

import json
import gzip
import os
import pathlib
import sys
import zipfile
from io import BytesIO

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "custom_components" / "leapmotor"))

import car3d  # noqa: E402

VIN = "LXXXTESTVIN000001"
CSV = "\ufeffid,Desc,id_TSP,ColorValue,BlendColor\n" \
      "0,金属黑,0,#353535,#111111\n" \
      "4,春芽绿,,#D2FFC6,#DCFFA3\n" \
      "9,苍松翠,7,#072217,#072F24\n"


def _zip(files: dict[str, str]) -> bytes:
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, text in files.items():
            zf.writestr(name, text)
    return buf.getvalue()


VIEWER_ZIP = _zip({"index.js": "// viewer", "textures/skybox_daytime.jpg": "day"})
MODEL_ZIP = _zip({"C10_2026/C10_2026_full_car.fbx": "fbx",
                  "C10_2026/C10_2026_CarPaintConfig.csv": CSV})


class FakeClient:
    """假客户端: 记录调用次数, 按 key 返回预置的素材包。"""

    def __init__(self, *, code: int = 0, h5: str = "H5KEY", src: str = "SRCKEY",
                 viewer: bytes = VIEWER_ZIP, model: bytes = MODEL_ZIP) -> None:
        self.code, self.h5, self.src, self.viewer, self.model = code, h5, src, viewer, model
        self.calls: list[str] = []
        self.zips: list[str] = []
        self.params: list[dict] = []

    def car_call(self, path, params=None, method="GET"):
        self.calls.append(path)
        self.params.append(dict(params or {}))
        if self.code:
            return {"code": self.code, "msg": "操作过于频繁"}
        return {"code": 0, "data": {
            "modelParam": {"carType": "C10", "year": 2026, "carTypeCode": "530舒享版",
                           "colorCode": 8, "roofColor": 0, "seat": 5, "extra": "x"},
            "h5Key": self.h5, "srcKey": self.src}}

    def fetch_asset_zip(self, vin, key, timeout=180):
        assert vin == VIN
        self.zips.append(key)
        return self.viewer if key == self.h5 else self.model


@pytest.fixture()
def wrapper_src(tmp_path: pathlib.Path) -> pathlib.Path:
    src = tmp_path / "www-car3d"
    (src / "textures").mkdir(parents=True)
    (src / "view.html").write_text("<html>wrapper</html>", encoding="utf-8")
    (src / "view.js").write_text("// wrapper", encoding="utf-8")
    (src / "textures" / "skybox_night_starry.jpg").write_bytes(b"jpg")
    return src


@pytest.fixture()
def base(tmp_path: pathlib.Path) -> pathlib.Path:
    return tmp_path / "car3d"


def test_static_compression_preserves_sources_and_refreshes_changed_viewer(base, wrapper_src):
    base.mkdir()
    source = base / "index.js"
    source.write_bytes(b"viewer source;" * 1000)
    (base / "FBX.worker.js").write_bytes(b"worker source;" * 300)
    car3d.install_wrapper(base, wrapper_src)
    packed = base / "index.js.gz"
    assert gzip.decompress(packed.read_bytes()) == source.read_bytes()
    assert gzip.decompress((base / "FBX.worker.js.gz").read_bytes()) == b"worker source;" * 300
    assert packed.stat().st_size < source.stat().st_size
    before = packed.stat().st_mtime_ns
    car3d.install_wrapper(base, wrapper_src)
    assert packed.stat().st_mtime_ns == before
    source.write_bytes(b"different viewer;" * 1000)
    os.utime(source, ns=(before + 2_000_000_000, before + 2_000_000_000))
    car3d.install_wrapper(base, wrapper_src)
    assert gzip.decompress(packed.read_bytes()) == source.read_bytes()
    assert not list(base.glob(".index.js.*"))


def test_static_compression_failure_keeps_original_viewer_usable(base, wrapper_src, monkeypatch):
    base.mkdir()
    original = b"original viewer;" * 1000
    (base / "index.js").write_bytes(original)
    stale = base / "index.js.gz"
    stale.write_bytes(gzip.compress(b"obsolete viewer"))
    os.utime(stale, (1, 1))
    monkeypatch.setattr(car3d.tempfile, "NamedTemporaryFile", lambda **_: (_ for _ in ()).throw(OSError("full")))
    car3d.install_wrapper(base, wrapper_src)
    assert (base / "index.js").read_bytes() == original
    assert not stale.exists()
    assert car3d.viewer_ready(base)
    assert (base / "view.html").is_file()


@pytest.mark.parametrize("car,year,trim,prefix", [
    ("C10", 2026, "", "C10_2026"),
    ("B10", 2025, "", "B10_2025"),
    ("B05", 2026, "605Max", "Lafa5_2026"),
    ("B05", 2026, "600Ultra", "Lafa5Ultra_2026"),
])
def test_preload_only_existing_files_for_selected_model(base, car, year, trim, prefix):
    other = "C16_2025/C16_2025_full_car.fbx"
    full = f"{prefix}/{prefix}_full_car.fbx"
    starter = f"{prefix}/{prefix}_starter_car.fbx"
    car3d.safe_extract(_zip({full: "full", other: "other"}), base)
    param = {"carTypeCode": trim}
    assert car3d.model_preloads(base, car, year, param) == [full]
    car3d.safe_extract(_zip({starter: "starter"}), base)
    assert car3d.model_preloads(base, car, year, param) == [starter, full]
    assert car3d.model_preloads(base, car, year, {**param, "alias": "unknown"}) == []
    assert car3d.model_preloads(base, "../C10", year, param) == []


def test_first_assemble_downloads_everything(base, wrapper_src):
    client = FakeClient()
    st = car3d.assemble_sync(client, VIN, base, wrapper_src, sleeper=lambda _s: None)

    assert client.calls == ["v3/api/carpicture/3d/key"]
    assert client.zips == ["H5KEY", "SRCKEY"]          # 查看器 + 模型, 各一次
    assert st["ready"] and st["viewer"] and st["model"]
    assert st["car_type"] == "C10" and st["year"] == 2026
    # 包装页铺进去了, 且与查看器同目录(相对 import ./index.js 才成立)
    assert (base / "view.html").read_text(encoding="utf-8") == "<html>wrapper</html>"
    assert (base / "textures" / "skybox_night_starry.jpg").is_file()
    assert (base / "index.js").is_file()
    assert (base / "C10_2026" / "C10_2026_full_car.fbx").is_file()
    # 清单里只留卡片需要的车型参数(顺手确认没有 VIN)
    man = json.loads((base / car3d.MANIFEST_NAME).read_text(encoding="utf-8"))
    assert man["model"]["param"] == {"carType": "C10", "year": 2026, "carTypeCode": "530舒享版",
                                     "colorCode": 8, "roofColor": 0, "seat": 5}
    assert VIN not in json.dumps(man)


@pytest.mark.parametrize("trim,asset,tsp", [
    ("605Max", "Lafa5", 11),
    ("600Ultra", "Lafa5Ultra", 33),
    ("500ULTRA", "Lafa5Ultra", 33),
])
def test_b05_uses_variant_assets_and_reuses_cache(base, wrapper_src, trim, asset, tsp):
    """同包普通版/Ultra 必须按版型选中；重启后的缓存检查和色表读取也用该映射。"""
    files = {}
    for variant, color in (("Lafa5", 11), ("Lafa5Ultra", 33)):
        prefix = f"{variant}_2026/{variant}_2026"
        files[f"{prefix}_full_car.fbx"] = "fbx"
        files[f"{prefix}_CarPaintConfig.csv"] = (
            f"id,Desc,id_TSP,ColorValue\n0,{variant},{color},#123456\n")

    class B05(FakeClient):
        def car_call(self, *args, **kwargs):
            resp = super().car_call(*args, **kwargs)
            resp["data"]["modelParam"].update(
                carType="B05", year=2026, carTypeCode=trim, colorCode=tsp)
            return resp

    client = B05(model=_zip(files))
    st = car3d.assemble_sync(client, VIN, base, wrapper_src, sleeper=lambda _: None)
    assert st["ready"] and st["car_type"] == "B05"
    assert st["model_param"]["carType"] == "B05"  # 查看器仍接收原始车型/版型
    assert st["colors"] == [{"tsp": tsp, "name": asset, "hex": "#123456"}]
    assert not (base / "B05_2026").exists()       # 不重命名官方资源
    assert car3d.colors_of(base, "B05", 2026, trim) == st["colors"]

    man = car3d.read_manifest(base)
    man["colors"] = []                          # 旧清单缺色表时从正确目录补回
    car3d.write_manifest(base, man)
    assert car3d.ready(base)
    client.calls.clear()
    client.zips.clear()
    cached = car3d.assemble_sync(client, VIN, base, wrapper_src, sleeper=lambda _: None)
    assert cached["ready"] and cached["colors"] == st["colors"]
    assert client.calls == [] and client.zips == []


@pytest.mark.parametrize("trim,other", [("600Ultra", "Lafa5"), ("605Max", "Lafa5Ultra")])
def test_b05_other_variant_does_not_satisfy_readiness(base, trim, other):
    """不能把同包的另一版型当作当前车已下载完成。"""
    car3d.safe_extract(_zip({f"{other}_2026/{other}_2026_full_car.fbx": "fbx"}), base)
    car3d.write_manifest(base, {"model": {"car_type": "B05", "year": 2026,
                                          "param": {"carTypeCode": trim}}})
    assert not car3d.model_ready(base, "B05", 2026, trim)
    assert not car3d.status(base)["model"]
    assert car3d.colors_of(base, "B05", 2026, trim) == []


def test_probe_stops_on_bare_variant_risk(base):
    class Risk(FakeClient):
        def car_call(self, path, params=None, method="GET"):
            self.calls.append(path)
            return {"code": 0, "data": {"h5Key": "h"}} if len(self.calls) == 1 else {"code": 1023}
    c = Risk()
    report = car3d.probe_sync(c, VIN, base, sleeper=lambda _: None)
    assert len(c.calls) == 2 and c.zips == []
    assert report["requests"] == 2 and "风控" in report["stopped"]


def test_probe_and_assemble_stop_on_package_risk(base, wrapper_src):
    class C(FakeClient):
        def fetch_asset_zip(self, vin, key, timeout=180, max_bytes=0):
            self.zips.append(key)
            return b'{"code":1023,"msg":"limited"}'
    c = C()
    report = car3d.probe_sync(c, VIN, base, sleeper=lambda _: None)
    assert c.zips == ["H5KEY"] and "风控" in report["stopped"]
    c2 = C()
    with pytest.raises(car3d.AssetError, match="风控"):
        car3d.assemble_sync(c2, VIN, base / "assemble", wrapper_src, sleeper=lambda _: None)
    assert c2.zips == ["H5KEY"]


def test_wrong_model_package_is_not_reported_ready(base, wrapper_src):
    c = FakeClient(model=_zip({"OTHER_2026/wrong.fbx": "wrong"}))
    with pytest.raises(car3d.AssetError, match="缺少"):
        car3d.assemble_sync(c, VIN, base, wrapper_src, sleeper=lambda _: None)
    assert not car3d.ready(base)


def test_probe_model_param_is_allowlisted(base):
    class C(FakeClient):
        def car_call(self, path, params=None, method="GET"):
            resp = super().car_call(path, params, method)
            resp["data"]["modelParam"].update(vin=VIN, token="PRIVATE-TOKEN", alias="lafa5")
            return resp
        def fetch_asset_zip(self, vin, key, timeout=180, max_bytes=0):
            return self.viewer if key == self.h5 else self.model
    report = car3d.probe_sync(C(), VIN, base, sleeper=lambda _: None)
    assert report["modelParam"]["alias"] == "lafa5"
    assert VIN not in json.dumps(report) and "PRIVATE-TOKEN" not in json.dumps(report)


def test_safe_extract_blocks_drive_paths(tmp_path):
    assert car3d.safe_extract(_zip({"Z:/escaped.txt": "bad", "ok.txt": "ok"}), tmp_path) == 1


def test_empty_fields_still_trigger_parameter_fallback(base, wrapper_src):
    class C(FakeClient):
        def car_call(self, path, params=None, method="GET"):
            if "osVersion" in (params or {}):
                self.calls.append(path)
                return {"code": 0, "data": {"modelParam": {}, "h5Key": "", "srcKey": "", "modelVersion": None}}
            return super().car_call(path, params, method)
    c = C()
    assert car3d.assemble_sync(c, VIN, base, wrapper_src, sleeper=lambda _: None)["ready"]
    assert len(c.calls) == 2


def test_second_assemble_is_offline(base, wrapper_src):
    client = FakeClient()
    car3d.assemble_sync(client, VIN, base, wrapper_src, sleeper=lambda _s: None)
    client.calls.clear()
    client.zips.clear()

    st = car3d.assemble_sync(client, VIN, base, wrapper_src, sleeper=lambda _s: None)
    assert client.calls == [] and client.zips == []      # 已装配 → 零请求
    assert st["ready"] and not st["changed"]


def test_wrapper_version_bump_reinstalls_without_model(base, wrapper_src, monkeypatch):
    client = FakeClient()
    car3d.assemble_sync(client, VIN, base, wrapper_src, sleeper=lambda _s: None)
    (base / "view.html").write_text("old", encoding="utf-8")
    client.calls.clear()
    client.zips.clear()

    monkeypatch.setattr(car3d, "ASSET_VERSION", car3d.ASSET_VERSION + 1)
    st = car3d.assemble_sync(client, VIN, base, wrapper_src, sleeper=lambda _s: None)
    assert (base / "view.html").read_text(encoding="utf-8") == "<html>wrapper</html>"
    assert st["changed"] and client.zips == []           # 只重铺包装页, 不重下模型(十几 MB)


def test_missing_viewer_only_downloads_viewer(base, wrapper_src):
    client = FakeClient()
    car3d.assemble_sync(client, VIN, base, wrapper_src, sleeper=lambda _s: None)
    (base / "index.js").unlink()                          # 查看器被外部删掉
    client.calls.clear()
    client.zips.clear()

    car3d.assemble_sync(client, VIN, base, wrapper_src, sleeper=lambda _s: None)
    assert client.zips == ["H5KEY"]                       # 模型不动


def test_throttle_between_packages(base, wrapper_src):
    slept: list[float] = []
    car3d.assemble_sync(FakeClient(), VIN, base, wrapper_src, sleeper=slept.append)
    assert slept == [car3d.THROTTLE_SECONDS]              # 两个包之间隔一下(风控节奏)


def test_risk_control_response_raises(base, wrapper_src):
    client = FakeClient(code=1023)
    with pytest.raises(RuntimeError, match="风控"):
        car3d.assemble_sync(client, VIN, base, wrapper_src, sleeper=lambda _s: None)
    assert client.zips == []                              # 命中即停, 不继续下包


def test_missing_keys_raise(base, wrapper_src):
    client = FakeClient(h5="", src="")
    with pytest.raises(RuntimeError, match="key"):
        car3d.assemble_sync(client, VIN, base, wrapper_src, sleeper=lambda _s: None)


def test_safe_extract_blocks_traversal(tmp_path):
    evil = _zip({"ok.txt": "fine", "../escape.txt": "nope", "/abs.txt": "nope",
                 "sub/../../up.txt": "nope"})
    dest = tmp_path / "out"
    count = car3d.safe_extract(evil, dest)
    assert count == 1
    assert (dest / "ok.txt").read_text(encoding="utf-8") == "fine"
    assert not (tmp_path / "escape.txt").exists()
    assert not (tmp_path / "up.txt").exists()


def test_parse_paint_colors_skips_rows_without_tspl():
    colors = car3d.parse_paint_colors(CSV)
    assert colors == [{"tsp": 0, "name": "金属黑", "hex": "#353535"},
                      {"tsp": 7, "name": "苍松翠", "hex": "#072217"}]   # 无 id_TSP 的春芽绿不入选
    assert car3d.parse_paint_colors("") == []
    assert car3d.parse_paint_colors("junk") == []


def test_colors_of_reads_model_csv(base, wrapper_src):
    car3d.assemble_sync(FakeClient(), VIN, base, wrapper_src, sleeper=lambda _s: None)
    assert car3d.colors_of(base, "C10", 2026) == [
        {"tsp": 0, "name": "金属黑", "hex": "#353535"},
        {"tsp": 7, "name": "苍松翠", "hex": "#072217"}]
    assert car3d.colors_of(base, "D99", 2026) == []
    # 清单里也留了一份(卡片不读 CSV, 直接看 info)
    assert json.loads((base / car3d.MANIFEST_NAME).read_text(encoding="utf-8"))["colors"]


def test_status_and_ready_semantics(base, wrapper_src):
    assert not car3d.ready(base)
    assert car3d.status(base) == {**car3d.status(base), "viewer": False, "model": False}
    car3d.assemble_sync(FakeClient(), VIN, base, wrapper_src, sleeper=lambda _s: None)
    assert car3d.ready(base)
    # 只看落盘: 模型包 fbX 在即为就绪(低模/整车模任一)
    (base / "C10_2026" / "C10_2026_full_car.fbx").rename(
        base / "C10_2026" / "C10_2026_starter_car.fbx")
    assert car3d.ready(base)


def test_force_redownloads(base, wrapper_src):
    client = FakeClient()
    car3d.assemble_sync(client, VIN, base, wrapper_src, sleeper=lambda _s: None)
    client.zips.clear()
    car3d.assemble_sync(client, VIN, base, wrapper_src, sleeper=lambda _s: None, force=True)
    assert client.zips == ["H5KEY", "SRCKEY"]


def test_no_car_type_in_response(base, wrapper_src):
    """云端返回成功但**没有车型参数**(车主反馈: 24 款 C11 走到这里)。

    旧版抛的是"云端未返回车型参数(3d/key 响应异常)" —— 看不出云端到底回了什么。
    现在: 面向用户的话术指向"该车型可能暂无云端 3D 素材", 并把响应形状放进 detail
    (诊断文件会带上), 便于远程定位是 code!=0 还是 data 空。
    """
    class C(FakeClient):
        def car_call(self, path, params=None, method="GET"):
            self.calls.append(path)
            return {"code": 0, "result": 0, "message": "请求成功", "data": {}}

    with pytest.raises(car3d.AssetError) as ei:
        car3d.assemble_sync(C(), VIN, base, wrapper_src, sleeper=lambda _s: None)
    assert "3D 车型参数" in str(ei.value)
    assert "code=0" in ei.value.detail and "data 键" in ei.value.detail


def test_key_api_error_carries_code_into_detail(base, wrapper_src):
    """3d/key 返回业务错误码: 错误信息里要带 code 与云端原因(否则无从上报)。"""
    class C(FakeClient):
        def car_call(self, path, params=None, method="GET"):
            self.calls.append(path)
            return {"code": 1, "result": 1, "message": "该车型暂不支持 3D 看车", "data": None}

    client = C()
    with pytest.raises(car3d.AssetError) as ei:
        car3d.assemble_sync(client, VIN, base, wrapper_src, sleeper=lambda _s: None)
    assert "code=1" in ei.value.detail and "暂不支持" in ei.value.detail
    assert client.zips == []                                     # 失败即停, 不下包


def test_non_zip_package_is_a_readable_error(base, wrapper_src):
    """车主反馈: "file is not a zip" —— 云端用一个 200 的 JSON/HTML 代替了素材包。

    不能再把英文的 zipfile 异常直接甩给用户: 要转成中文说明 + 头部特征进 detail,
    并把它算作 AssetError(诊断文件会带上 detail)。
    """
    html = b"<!DOCTYPE html><html><body>502 Bad Gateway</body></html>"

    class C(FakeClient):
        def fetch_asset_zip(self, vin, key, timeout=180):
            self.zips.append(key)
            return html

    with pytest.raises(car3d.AssetError) as ei:
        car3d.assemble_sync(C(), VIN, base, wrapper_src, sleeper=lambda _s: None)
    assert "不是压缩包" in str(ei.value)
    assert "502 Bad Gateway" in ei.value.detail                  # 头部特征(可打印)留下了
    assert "File is not a zip" not in str(ei.value)


def test_gzip_wrapped_and_truncated_packages(base, wrapper_src):
    """容错: gzip 包裹的 zip 能解开; 半截包给"下载不完整"而不是 zipfile 的英文异常。"""
    import gzip as _gzip
    wrapped = _gzip.compress(MODEL_ZIP)

    class G(FakeClient):
        def fetch_asset_zip(self, vin, key, timeout=180):
            self.zips.append(key)
            return VIEWER_ZIP if key == self.h5 else wrapped

    car3d.assemble_sync(G(), VIN, base, wrapper_src, sleeper=lambda _s: None)
    assert (base / "C10_2026" / "C10_2026_full_car.fbx").is_file()

    base2 = base.parent / "car3d2"

    class T(FakeClient):
        def fetch_asset_zip(self, vin, key, timeout=180):
            self.zips.append(key)
            return MODEL_ZIP[: len(MODEL_ZIP) // 2]              # 半截

    with pytest.raises(car3d.AssetError, match="不完整"):
        car3d.assemble_sync(T(), VIN, base2, wrapper_src, sleeper=lambda _s: None)


def test_zip_bytes_empty_payload(base):
    with pytest.raises(car3d.AssetError, match="为空"):
        car3d.zip_bytes(b"", "查看器素材包")


def test_wrapper_upgrade_keeps_assets_ready(base, wrapper_src, monkeypatch):
    """包装页版本升级**不该**让素材"变回未就绪"(否则卡片会退回下载按钮, 用户以为白下了)。"""
    car3d.assemble_sync(FakeClient(), VIN, base, wrapper_src, sleeper=lambda _s: None)
    (base / "view.html").write_text("old", encoding="utf-8")

    monkeypatch.setattr(car3d, "ASSET_VERSION", car3d.ASSET_VERSION + 1)
    assert car3d.ready(base)                                   # 只看查看器+模型, 与版本无关
    car3d.install_wrapper(base, wrapper_src)                    # 集成 setup 时顺手刷新的那次
    assert (base / "view.html").read_text(encoding="utf-8") == "<html>wrapper</html>"
    man = json.loads((base / car3d.MANIFEST_NAME).read_text(encoding="utf-8"))
    assert man["asset_version"] == car3d.ASSET_VERSION          # 已升到新版本(monkeypatch 后的值)
    assert car3d.status(base)["colors"]                        # 升级不碰色表


# ── 3D 素材深度探针 ──────────────────────────────────────────────

def test_package_error_carries_http_shape(base, wrapper_src):
    """素材包不是 zip 时, 失败详情要带上 HTTP 响应形状(状态码/内容类型/头部)。"""
    class C(FakeClient):
        last_asset_meta = {"status": 200, "content_type": "text/html",
                           "bytes": 52, "head": "<!DOCTYPE html>...", "looks_zip": False}

        def fetch_asset_zip(self, vin, key, timeout=180, max_bytes=0):
            self.zips.append(key)
            return b"<!DOCTYPE html><html>502</html>"

    with pytest.raises(car3d.AssetError) as ei:
        car3d.assemble_sync(C(), VIN, base, wrapper_src, sleeper=lambda _s: None)
    assert "HTTP" in ei.value.detail and "text/html" in ei.value.detail


def test_probe_reports_shapes_and_redacts(base):
    """探针: 报告要能转发 —— 有响应形状, 但**不含 VIN 与完整素材 key**。"""
    seen: list[float] = []

    class C(FakeClient):
        def car_call(self, path, params=None, method="GET"):
            self.calls.append(path)
            if path.endswith("3d/key"):
                return {"code": 0, "message": "请求成功", "data": {
                    "modelParam": {"carType": "C11", "year": 2024},
                    "h5Key": "H" * 40, "srcKey": "S" * 40}}
            return {"code": 0, "data": {"key": "K" * 30, "url": "https://oss/x.png"}}

        def fetch_asset_zip(self, vin, key, timeout=180, max_bytes=0):
            self.zips.append(key)
            self.last_asset_meta = {"status": 200, "content_type": "application/zip",
                                    "bytes": 3, "head": "PK.", "looks_zip": True}
            return MODEL_ZIP

    client = C()
    rep = car3d.probe_sync(client, VIN, base, extra={"vin_fingerprint": "fp123"},
                           deep=True, sleeper=seen.append)

    assert rep["vin_fingerprint"] == "fp123"
    assert rep["modelParam"] == {"carType": "C11", "year": 2024}
    assert rep["keys"]["h5Key"] == {"len": 40, "prefix": "HHHHHH"}       # 只留形状
    assert [p["what"] for p in rep["packages"]] == ["查看器包(h5Key)", "本车模型包(srcKey)"]
    assert rep["packages"][0]["zip"]["valid"] and rep["packages"][0]["zip"]["entries"] >= 1
    assert rep["car2d_fields"] == ["key", "url"]
    assert rep["requests"] == 5                     # 1 + 1(variants 对比) + 2 包 + 1(2D)
    assert set(rep["key3d_params"]) == {"vin", "osVersion"}   # 与官方 App 一致的参数集
    assert set(rep["key3d_variants"]) == {"full(deviceID+vin+osVersion)", "bare(vin)"}
    assert seen == [car3d.THROTTLE_SECONDS] * 4                # 四次请求之间都节流(variants 也算)
    # 报告落盘且不含 VIN / 完整 key
    files = list(base.glob("car3d_diag_*.json"))
    assert len(files) == 1
    text = files[0].read_text(encoding="utf-8")
    assert VIN not in text and "H" * 40 not in text and "S" * 40 not in text


def test_probe_saves_non_zip_package_and_stops_on_risk(base):
    """深探: 不是 zip 的包会另存一份(便于看内容); 风控命中则立刻停(不重试)。"""
    class Bad(FakeClient):
        def car_call(self, path, params=None, method="GET"):
            self.calls.append(path)
            return {"code": 0, "data": {"modelParam": {"carType": "C10", "year": 2026},
                                        "h5Key": "h", "srcKey": "s"}}

        def fetch_asset_zip(self, vin, key, timeout=180, max_bytes=0):
            self.zips.append(key)
            self.last_asset_meta = {"status": 200, "content_type": "text/html", "bytes": 5,
                                    "head": "<html", "looks_zip": False}
            return b"<html"

    rep = car3d.probe_sync(Bad(), VIN, base, deep=True, sleeper=lambda _s: None)
    assert rep["packages"][0]["zip"]["valid"] is False
    assert (base / rep["packages"][0]["saved"]).read_bytes() == b"<html"

    class Risky(FakeClient):
        def car_call(self, path, params=None, method="GET"):
            self.calls.append(path)
            return {"code": 1023, "msg": "操作过于频繁"}

    base2 = base.parent / "car3d-risk"
    rep2 = car3d.probe_sync(Risky(), VIN, base2, deep=True, sleeper=lambda _s: None)
    assert "风控" in rep2["stopped"] and "packages" not in rep2
    assert rep2["requests"] == 1                                        # 命中即停, 不再打接口


def test_probe_extra_assembles_integration_side(tmp_path):
    """探针报告里"集成侧"那部分: 车型/版本/判据链路齐全, 且不夹带 VIN 或整张色表。"""
    import importlib.util
    import pathlib as _p
    # probe_extra 用了相对导入(包内), 离线测试时按包方式挂进来
    pkg_dir = ROOT / "custom_components"
    spec = importlib.util.spec_from_file_location(
        "leapmotor", pkg_dir / "leapmotor" / "__init__.py",
        submodule_search_locations=[str(pkg_dir / "leapmotor")])
    pkg = importlib.util.module_from_spec(spec)
    sys.modules["leapmotor"] = pkg
    try:
        spec.loader.exec_module(pkg)          # 引 HA 会失败
    except Exception:                          # noqa: BLE001
        pass
    spec2 = importlib.util.spec_from_file_location(
        "leapmotor.car3d", pkg_dir / "leapmotor" / "car3d.py")
    mod = importlib.util.module_from_spec(spec2)
    sys.modules["leapmotor.car3d"] = mod
    spec2.loader.exec_module(mod)

    extra = mod.probe_extra(
        integration_version="0.3.0", car_type="C11", sub_version="1.2.3",
        vin_fingerprint="fp-abc", ready=False,
        status={"viewer": True, "model": False, "colors": [{"tsp": 1}], "dir": "/x"},
        state={"state": "error", "error": "素材下载失败", "detail": "3d/key: code=0"},
        energy_pref="auto", latched=False,
        signals={"range_fuel_cltc": 180, "range_ev_cltc": 100, "range_total_cltc": 280},
    )
    assert extra["car_type"] == "C11" and extra["integration_version"] == "0.3.0"
    assert "colors" not in extra["car3d"]["status"] and "dir" not in extra["car3d"]["status"]
    assert extra["car3d"]["last_error_detail"] == "3d/key: code=0"
    assert extra["reev"]["now"] is True                      # 燃油续航 180 > 0
    assert extra["reev"]["ranges"]["total_km"] == 280
    # 收尾: 别把半初始化的包留在 sys.modules 里影响别的测试
    sys.modules.pop("leapmotor.car3d", None)
    sys.modules.pop("leapmotor", None)


# ── 云端用 modelType 声明"这辆车有什么素材"(车型差异只在这里, 端点各车型一致) ──
def test_model_type_2_means_no_cloud_3d(base, wrapper_src):
    """modelType=2: 云端只有 2D 素材 → 这是**信息不是故障**(官方 App 也静默回退 2D)。

    车主反馈里"24 款 C11 3dkey 响应异常"就是这一支: 旧版把它当异常抛, 车主看到的是
    "素材下载失败"。现在给明确说法, 且标记 unsupported(不诱导反复重试)。
    """
    class C(FakeClient):
        def car_call(self, path, params=None, method="GET"):
            self.calls.append(path)
            return {"code": 0, "result": 0, "message": "请求成功",
                    "data": {"modelType": 2, "modelParam": {}, "h5Key": "", "srcKey": ""}}

    with pytest.raises(car3d.AssetError) as ei:
        car3d.assemble_sync(C(), VIN, base, wrapper_src, sleeper=lambda _s: None)
    assert ei.value.unsupported is True and ei.value.model_type == 2
    assert "2D" in str(ei.value) and "modelType=2" in ei.value.detail
    assert "没有 3D" not in str(ei.value)   # 只陈述"这次没下发", 不断言"这辆车没有 3D"


def test_model_type_1_and_missing_stay_distinguishable(base, wrapper_src):
    """modelType=1(没有车模素材)同样归为 unsupported; 但没有 modelType 的空响应仍是异常。"""
    class NoModel(FakeClient):
        def car_call(self, path, params=None, method="GET"):
            self.calls.append(path)
            return {"code": 0, "data": {"modelType": 1}}

    with pytest.raises(car3d.AssetError) as ei:
        car3d.assemble_sync(NoModel(), VIN, base, wrapper_src, sleeper=lambda _s: None)
    assert ei.value.unsupported is True and "没有这辆车的车模素材" in str(ei.value)

    class Empty(FakeClient):
        def car_call(self, path, params=None, method="GET"):
            self.calls.append(path)
            return {"code": 0, "result": 0, "message": "请求成功", "data": {}}

    with pytest.raises(car3d.AssetError) as ei2:
        car3d.assemble_sync(Empty(), VIN, base.parent / "car3d-empty", wrapper_src,
                            sleeper=lambda _s: None)
    assert ei2.value.unsupported is False                 # 没声明 modelType 的空中转 = 真异常
    assert "data 键=[]" in ei2.value.detail


def test_unsupported_is_remembered_for_the_card(base, wrapper_src):
    """unsupported 要落进 manifest: 重启/换浏览器后卡片仍能直接说明情况, 不必再试一次。"""
    car3d.note_unsupported(base, 2, "这辆车在云端没有 3D 车模素材(云端只提供 2D 素材)")
    st = car3d.status(base)
    assert st["unsupported"]["model_type"] == 2
    assert "2D" in st["unsupported"]["reason"]
    # 装配成功时 manifest 整体重写 → 旧的 unsupported 标记自然消失
    car3d.assemble_sync(FakeClient(), VIN, base, wrapper_src, sleeper=lambda _s: None)
    assert not car3d.status(base)["unsupported"]


def test_probe_records_model_declaration(base):
    """探针报告要带上"云端声明了什么"(modelType/modelVersion/直链目录段)—— 只有它能解释
    为什么某辆车装不了 3D(端点各车型一致, 差异全在响应里)。"""
    class C(FakeClient):
        def car_call(self, path, params=None, method="GET"):
            self.calls.append(path)
            if path.endswith("3d/key"):
                return {"code": 0, "data": {
                    "modelType": 2, "modelVersion": None, "modelParam": {},
                    "h5Key": "", "srcKey": "",
                    "shareBindUrl": "http://x.oss-cn-hangzhou.aliyuncs.com/carModelPicture/"
                                    "abc?Expires=1&Signature=SECRET"}}
            return {"code": 0, "data": {"key": "K"}}

    rep = car3d.probe_sync(C(), VIN, base, sleeper=lambda _s: None)
    assert rep["model_type"] == 2 and rep["model_version"] is None
    assert rep["oss_dir"] == "carModelPicture" and "SECRET" not in json.dumps(rep)
    assert "modelType=2" in rep["key3d_envelope"]
    assert rep["packages"] == [{"what": "查看器包(h5Key)", "skipped": "云端没给这个 key"},
                               {"what": "本车模型包(srcKey)", "skipped": "云端没给这个 key"}]


def test_asset_params_match_the_app(base, wrapper_src):
    """素材请求参数要与官方 App 一致: `deviceID + vin + osVersion`(osVersion 是能力声明)。

    只发 vin 时云端少一份"这端能不能渲染 3D"的依据, 可能降级(车主反馈 C11: App 里有 3D,
    集成却拿不到车型参数)。deviceID 从会话取; 会话还没有时至少要有 osVersion。
    """
    client = FakeClient()
    car3d.assemble_sync(client, VIN, base, wrapper_src, sleeper=lambda _s: None)
    key_call = client.params[0]
    assert key_call["vin"] == VIN and key_call["osVersion"] == car3d.APP_WEBVIEW_VERSION
    assert "deviceID" not in key_call                      # FakeClient 没有会话 → 不强塞

    class WithSession(FakeClient):
        session = type("S", (), {"device_id": "0123456789abcdef"})

    got = car3d.asset_params(WithSession(), VIN)
    assert got["deviceID"] == "0123456789abcdef"
    assert set(got) == {"vin", "deviceID", "osVersion"}


def test_model_type_2_is_not_written_as_a_permanent_fact():
    """modelType=2 只是"这次没下发", 不许落盘成永久结论(=1 才是硬事实)。

    静态检查: 落盘分支必须比对 MODEL_TYPE_NONE —— 车主已证实 C11 在 App 里有 3D,
    写成"这辆车没有 3D 素材"就是一条会过期的断言。
    """
    import ast as _ast
    src = pathlib.Path(ROOT / "custom_components" / "leapmotor" / "car3d.py").read_text(
        encoding="utf-8")
    assert "note_unsupported" in src
    tree = _ast.parse(src)
    segs = [n for n in _ast.walk(tree) if isinstance(n, _ast.Try)
            and "note_unsupported" in (_ast.get_source_segment(src, n) or "")]
    assert segs, "找不到 note_unsupported 的落盘分支"
    seg = _ast.get_source_segment(src, segs[0]) or ""
    assert "MODEL_TYPE_NONE" in seg, "modelType=2 也会被落盘(应只对 =1 落盘)"


# ── 参数退回保险: 先按 App 参数, 拿不到内容才退回"只发 vin" ──
def test_key3d_falls_back_to_bare_params(base, wrapper_src):
    """App 参数拿不到内容时退回旧写法再试一次 —— 保证参数对齐**不会比改之前更差**。

    为什么需要: 加 `osVersion/deviceID` 的依据是"官方 App 能拿到 3D", 但云端认不认多出来的
    字段无法离线验证; 这一步让最坏情况退化成改动前的行为, 并把"用了哪套参数"记进 manifest。
    """
    class C(FakeClient):
        def car_call(self, path, params=None, method="GET"):
            self.calls.append(path)
            self.params.append(dict(params or {}))
            if "osVersion" in (params or {}):            # App 参数 → 空响应
                return {"code": 0, "result": 0, "message": "请求成功", "data": {}}
            return {"code": 0, "data": {                 # 只发 vin → 有内容
                "modelParam": {"carType": "C10", "year": 2026},
                "h5Key": self.h5, "srcKey": self.src, "modelType": 3}}

    client = C()
    st = car3d.assemble_sync(client, VIN, base, wrapper_src, sleeper=lambda _s: None)
    assert st["ready"] is True
    assert [p.keys() for p in client.params][0] != [p.keys() for p in client.params][1]
    man = json.loads((base / car3d.MANIFEST_NAME).read_text(encoding="utf-8"))
    assert "只发 vin" in man["key3d_params"]                 # 参数来源留痕
    assert len([c for c in client.calls if c.endswith("3d/key")]) == 2


def test_key3d_does_not_retry_when_payload_or_risk(base, wrapper_src):
    """"有内容"或"命中风控"都不再发第二个请求(风控红线: 命中即停, 不重试)。"""
    class Payload(FakeClient):                       # 有 modelParam → 一次搞定
        pass

    c1 = Payload()
    car3d.assemble_sync(c1, VIN, base, wrapper_src, sleeper=lambda _s: None)
    assert len([c for c in c1.calls if c.endswith("3d/key")]) == 1

    class EmptyThenRisk(FakeClient):                 # 第一次空 → 第二次风控 → 不再发第三个
        def car_call(self, path, params=None, method="GET"):
            self.calls.append(path)
            self.params.append(dict(params or {}))
            n = len([c for c in self.calls if c.endswith("3d/key")])
            return ({"code": 0, "data": {}} if n == 1
                    else {"code": 1023, "msg": "操作过于频繁"})

    c2 = EmptyThenRisk()
    with pytest.raises(car3d.AssetError, match="风控"):
        car3d.assemble_sync(c2, VIN, base.parent / "car3d-risk2", wrapper_src,
                            sleeper=lambda _s: None)
    assert len([c for c in c2.calls if c.endswith("3d/key")]) == 2   # 命中后不再继续
