"""3D 车模: 素材懒装配 + 本地缓存 + 静态服务。

素材 = **通用查看器包**(约 5 MB, 所有车型共用一份) + **本车模型包**(约 10 MB, 按车型+年份)。
两者都由云端按 VIN 下发, 用户点击下载时装配一次, 落到
`config/leapmotor-car3d/`, 之后完全本地复用(离线可用)。
落盘目录同时挂到集成的静态路径 `/leapmotor-card/car3d/`, 卡片的 iframe 直接加载其中的
包装页 `view.html`(逻辑见 `www/car3d/view.js`)负责初始化、取景、背景、车漆与车辆状态回显,
云端素材保持原样。

请求与风控: 正常装配 3 个只读 GET，空响应回退时最多 4 个，每车装配后本地复用;
失败不自动重试(留冷却期, 由用户手动再试); 全程不涉及任何车控指令。
"""

from __future__ import annotations

import functools
import gzip
import json
import logging
import os
import re
import tempfile
import time
import zipfile
from io import BytesIO
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

if TYPE_CHECKING:                     # 只为类型标注: 本模块的核心逻辑要能离线单测(见 tests/)
    from homeassistant.core import HomeAssistant


class AssetError(RuntimeError):
    """素材装配失败 —— 短中文说法给人看, `detail` 留给日志/诊断文件远程定位。

    为什么分开: 卡片状态行只放得下一句话(会被截断), 而"云端到底回了什么"是我们
    远程判断车主问题的唯一线索(有车主反馈过 3dkey 异常 / "file is not a zip")。

    `unsupported=True` = **不是失败, 是这辆车云端就没有 3D 素材**(云端用 `modelType`
    声明: 3=有 3D / 2=只有 2D 素材 / 1=没有车模素材 —— 取自 App 的分支, 见 MODEL_TYPE_*)。
    这种情况不该反复重试, 也不该让车主以为是自己网络的问题。
    """

    def __init__(self, message: str, detail: str = "", unsupported: bool = False,
                 model_type: Any = None) -> None:
        super().__init__(message)
        self.detail = detail
        self.unsupported = unsupported
        self.model_type = model_type


# 云端在 `3d/key` 的 data 里用 modelType 声明**这次给什么素材**(官方 App 就是照它分支的):
#   3 = 下发 3D 车模 / 2 = 只给 2D(App 静默回退 2D, 不报错) / 1 = 没有车模素材
# ⚠️ modelType=2 **不等于**"这辆车没有 3D": 车主已证实 C11 在官方 App 里是有 3D 的。
#    它的成因**未验证/存疑**(可能是按客户端声明降级, 也可能与车型或素材包状态有关) ——
#    所以只陈述"这次拿到了什么", 并把请求参数与响应形状一起记下来(见 asset_params())。
MODEL_TYPE_3D = 3
MODEL_TYPE_2D = 2
MODEL_TYPE_NONE = 1

# 素材接口的 `osVersion` 参数: 官方 App 每次请求都带, 填的是自己渲染内核的版本
# (`WebView.getCurrentWebViewPackage().versionName`, 并与内置内核取较大者)。
# ⚠️ **存疑(未验证)**: 云端是否拿它决定给不给 3D —— **不知道**。车主判断"与渲染内核无关",
#    我们也没有任何证据能证实或证伪。所以带它**只因为"要与 App 的请求形状一致"**
#    (App 每次都发, 少一项就不是官方请求形状), 不基于任何因果假设。
#    最坏情况已兜住: `fetch_key3d` 在"什么都没拿到"时会退回只发 vin 的旧写法。
# 值按现代内核版本上报(HA 前端本来跑在现代浏览器内核上, 不算虚报能力)。
APP_WEBVIEW_VERSION = "120.0.6099.230"


def asset_params(client: Any, vin: str) -> dict[str, str]:
    """3D 素材接口的请求参数 —— 与官方 App **逐字段一致**: `deviceID + vin + osVersion`。

    App 里这三项是固定的(见 `CarViewModel` 的 `getModelKey` 一系调用), 我们此前只发 `vin`。
    对齐的理由是"请求形状应当与官方客户端一致", **不是**"确定 osVersion 会影响结果"
    —— 这一点存疑且未验证(见上方常量说明)。`deviceID` 从会话取; `fetch_key3d` 负责在
    带全参数拿不到内容时退回只发 vin, 因此对齐不会让任何车型比改动前更差。
    """
    s = getattr(client, "session", None)
    params = {"vin": vin, "osVersion": APP_WEBVIEW_VERSION}
    device_id = str(getattr(s, "device_id", "") or "")
    if device_id:
        params["deviceID"] = device_id
    return params


def _domain() -> str:
    """集成 domain(延迟导入 —— 本模块的纯逻辑要能被 tests/ 直接 import, 不引 HA)."""
    from .const import DOMAIN
    return DOMAIN

log = logging.getLogger(__name__)

DIR_NAME = "leapmotor-car3d"          # config/ 下的落盘目录
URL_DIR = "car3d"                     # 静态路径后缀: /leapmotor-card/car3d/
ASSET_VERSION = 14                    # 包装页版本: 变了只重铺包装页, 模型不重下
WRAPPER_FILES = ("view.html", "view.js", "textures/skybox_night_starry.jpg")
MODEL_PARAM_FIELDS = ("carType", "year", "carTypeCode", "colorCode", "roofColor",
                      "seat", "sdkVersion", "theme", "alias")
VIEWER_MARK = "index.js"              # 查看器包落盘的标志文件
MANIFEST_NAME = "manifest.json"
THROTTLE_SECONDS = 3                  # 两个素材包之间的请求间隔
COOLDOWN_SECONDS = 900                # 装配失败后的冷却时间(期间不再自动尝试)


# ── 路径与状态(纯文件系统, 便于离线单测) ──────────────────────────
def root(hass: HomeAssistant) -> Path:
    """落盘目录(与 cards 一样: 集成自带的静态路径直接映射这个目录)。"""
    return Path(hass.config.path(DIR_NAME))


def _vin_fingerprint(vin: object) -> str:
    if __package__:
        from .diag_redact import vin_fingerprint
    else:  # Keep the offline module tests usable when they import car3d directly.
        from diag_redact import vin_fingerprint
    return vin_fingerprint(vin)


def profile_root(hass: HomeAssistant, coord: Any) -> Path:
    """按 VIN 隔离车模；将单车旧目录无损认领到原车。"""
    from .const import DOMAIN

    legacy = root(hass)
    vin = str(getattr(coord, "vin", "") or "")
    fingerprint = _vin_fingerprint(vin)
    if not fingerprint:
        return legacy
    manifest = read_manifest(legacy)
    owner = str(manifest.get("vin_fingerprint") or "")
    entries = hass.config_entries.async_entries(DOMAIN)
    if owner == fingerprint:
        return legacy
    if not owner and len(entries) == 1:
        # 单车升级时把现有离线资源标记为该车；后续再添加车辆也不会误共享。
        write_manifest(legacy, {**manifest, "vin_fingerprint": fingerprint})
        return legacy
    return legacy / "vehicles" / fingerprint


def wrapper_src() -> Path:
    """包装页与星空贴纸的**源**目录(集成自带, 装配时复制进落盘目录)。"""
    return Path(__file__).parent / "www" / "car3d"


def model_prefix(car_type: str, year: Any, car_type_code: str = "") -> str:
    """模型包的实际目录与前缀；保留接口车型名，由版型解析资源别名。

    B05 包同时带 Lafa5 与 Lafa5Ultra，官方查看器按版型里的 Ultra 分支选择。
    后端检查和色表读取必须使用同一规则，不能取包里的第一个模型目录。
    """
    if car_type == "B05":
        car_type = "Lafa5Ultra" if "ultra" in str(car_type_code or "").lower() else "Lafa5"
    return f"{car_type}_{year}"


def viewer_ready(base: Path) -> bool:
    return (base / VIEWER_MARK).is_file()


def model_ready(base: Path, car_type: str, year: Any, car_type_code: str = "") -> bool:
    """模型包是否已落盘(只要目录里有 `*_car.fbx` 就算完整 —— 低模/整车模任一即可)。"""
    if not car_type:
        return False
    sub = base / model_prefix(car_type, year, car_type_code)
    try:
        return any(sub.glob("*_car.fbx"))
    except OSError:
        return False


def read_manifest(base: Path) -> dict:
    try:
        return json.loads((base / MANIFEST_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def write_manifest(base: Path, data: dict) -> None:
    try:
        base.mkdir(parents=True, exist_ok=True)
        (base / MANIFEST_NAME).write_text(
            json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    except OSError as err:
        log.warning("写 3D 素材清单失败: %s", err)


def note_unsupported(base: Path, model_type: Any, reason: str) -> None:
    """把"云端没有这辆车的 3D 素材"记进 manifest —— 卡片下次打开直接看到说明。

    为什么值得落盘: 云端按 VIN 决定给不给 3D 素材(车型差异只体现在响应里, 见 envelope()),
    这类车重试多少次都一样; 记下来就不会每次打开卡片都重试一遍、也不会让车主以为是自己的
    网络问题。真要重试(比如云端后来补了素材)仍然可以手动点"下载"。
    """
    man = read_manifest(base)
    man["unsupported"] = {"model_type": model_type, "reason": reason,
                          "checked_at": time.time()}
    write_manifest(base, man)


def status(base: Path) -> dict:
    """不联网的现状: 查看器/模型是否就绪 + 已落盘的车型 + 包装页版本。"""
    man = read_manifest(base)
    model = man.get("model") or {}
    car_type, year = model.get("car_type") or "", model.get("year")
    param = model.get("param") or {}
    return {
        "dir": str(base),
        "viewer": viewer_ready(base),
        "model": model_ready(base, car_type, year, param.get("carTypeCode") or ""),
        "car_type": car_type,
        "year": year,
        "model_param": param,
        "unsupported": man.get("unsupported") or None,
        "asset_version": int(man.get("asset_version") or 0),
        "fetched_at": man.get("fetched_at"),
        "colors": man.get("colors") or [],
        "preload": model_preloads(base, car_type, year, param),
    }


def model_preloads(base: Path, car_type: str, year: Any, param: dict) -> list[str]:
    """只提示本车实际存在的 FBX；未知别名交给官方查看器自行选择。"""
    if param.get("alias"):
        return []
    prefix = model_prefix(car_type, year, param.get("carTypeCode") or "")
    if not re.fullmatch(r"[A-Za-z0-9]+_[0-9]{4}", prefix):
        return []
    return [rel for part in ("starter", "full")
            if (base / (rel := f"{prefix}/{prefix}_{part}_car.fbx")).is_file()]


def ready(base: Path) -> bool:
    """能不能用 3D: **只看查看器与模型在不在**(包装页是集成setup时铺的本地文件, 不算条件)。"""
    st = status(base)
    return bool(st["viewer"] and st["model"])


# ── 车型车漆色表(模型包里自带 CarPaintConfig.csv) ────────────────────
def parse_paint_colors(csv_text: str) -> list[dict]:
    """解析 `CarPaintConfig.csv` → 可选车漆列表。

    只取 `id_TSP` 非空的行: 那才是云端按 VIN 会下发的颜色码(`modelParam.colorCode`
    用的就是这一列), 空行的颜色在 App 里也不可选。
    列: `id,Desc,id_TSP,ColorValue,BlendColor,...`(见模型包)。
    """
    out: list[dict] = []
    lines = [ln for ln in str(csv_text or "").replace("\r\n", "\n").split("\n") if ln.strip()]
    if not lines:
        return out
    head = [c.strip().lstrip("\ufeff") for c in lines[0].split(",")]
    try:
        i_name = head.index("Desc")
        i_tsp = head.index("id_TSP")
        i_val = head.index("ColorValue")
    except ValueError:
        return out
    for ln in lines[1:]:
        cols = ln.split(",")
        if len(cols) <= max(i_name, i_tsp, i_val):
            continue
        tsp, name, val = cols[i_tsp].strip(), cols[i_name].strip(), cols[i_val].strip()
        if not tsp or not name:
            continue
        if len(val) == 7 and val.startswith("#"):
            out.append({"tsp": int(tsp) if tsp.isdigit() else tsp, "name": name,
                        "hex": val.upper()})
    return out


def colors_of(base: Path, car_type: str, year: Any, car_type_code: str = "") -> list[dict]:
    """从模型包里读该车型的车漆色表(读不到就返回空表 —— 卡片此时只显示"自动")。"""
    if not car_type:
        return []
    sub = base / model_prefix(car_type, year, car_type_code)
    try:
        for path in sorted(sub.glob("*CarPaintConfig.csv")):
            return parse_paint_colors(path.read_text(encoding="utf-8-sig", errors="replace"))
    except OSError:
        pass
    return []


# ── 装配(阻塞; 调用方放进 executor) ────────────────────────────────
def safe_extract(zip_bytes: bytes, dest: Path) -> int:
    """解压到 dest, 拒绝越界条目(绝对路径 / `..`)与符号链接。返回文件数。"""
    dest.mkdir(parents=True, exist_ok=True)
    count = 0
    with zipfile.ZipFile(BytesIO(zip_bytes)) as zf:
        for info in zf.infolist():
            name = info.filename.replace("\\", "/")
            if name.endswith("/"):
                continue
            parts = [p for p in name.split("/") if p not in ("", ".")]
            if not parts or name.startswith("/") or any(p == ".." for p in parts):
                log.warning("素材包里有越界条目, 已跳过: %s", info.filename[:120])
                continue
            if (info.external_attr >> 16) & 0o170000 == 0o120000:      # 符号链接
                log.warning("素材包里符号链接, 已跳过: %s", info.filename[:120])
                continue
            target = dest.joinpath(*parts)
            if ":" in parts[0] or not target.resolve().is_relative_to(dest.resolve()):
                log.warning("素材包条目不在目标目录内, 已跳过")
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as src, open(target, "wb") as dst:
                dst.write(src.read())
            count += 1
    return count


def prepare_static_assets(base: Path) -> None:
    """为现有静态服务生成 gzip 副本；失败仍可加载原文件，不改官方素材。"""
    for name in ("index.js", "FBX.worker.js"):
        source, target = base / name, base / f"{name}.gz"
        temporary: Path | None = None
        try:
            if not source.is_file():
                continue
            stamp = source.stat()
            if target.is_file() and target.stat().st_mtime_ns == stamp.st_mtime_ns:
                continue
            # 静态服务会优先选择 .gz；旧副本必须先失效，压缩失败时才能真正回退原文件。
            target.unlink(missing_ok=True)
            packed = gzip.compress(source.read_bytes(), compresslevel=6, mtime=0)
            if len(packed) >= stamp.st_size:
                continue
            if source.stat().st_mtime_ns != stamp.st_mtime_ns:
                continue
            with tempfile.NamedTemporaryFile(dir=base, prefix=f".{name}.", delete=False) as out:
                temporary = Path(out.name)
                out.write(packed)
            os.utime(temporary, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
            temporary.replace(target)
        except OSError as err:
            log.warning("3D 静态资源压缩未完成，继续使用原文件: %s", err)
        finally:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass


def install_wrapper(base: Path, src: Path, version: int | None = None) -> list[str]:
    """把包装页与星空贴图铺进落盘目录(版本一致且文件在就跳过)。

    铺完就地更新 manifest 里的 `asset_version` —— 这些是纯本地文件(几 KB),
    升级它们**不该**让素材"变回未就绪"(那会让卡片退回下载按钮): 只要查看器与模型在,
    就仍然是 ready, 包装页由集成在 setup 时顺手刷新。
    """
    version = ASSET_VERSION if version is None else version      # 取当前值(便于热改/单测)
    prepare_static_assets(base)
    man = read_manifest(base)
    if int(man.get("asset_version") or 0) == version and all(
            (base / f).is_file() for f in WRAPPER_FILES):
        return []
    done: list[str] = []
    for rel in WRAPPER_FILES:
        s = src / rel
        if not s.is_file():
            log.warning("包装页源文件缺失: %s", s)
            continue
        d = base / rel
        d.parent.mkdir(parents=True, exist_ok=True)
        d.write_bytes(s.read_bytes())
        done.append(rel)
    if done:
        man["asset_version"] = version
        write_manifest(base, man)
    return done


def _oss_dir(url: Any) -> str:
    """素材直链的**目录段**(carModel3D / carModelPicture)—— 云端给的是 3D 还是 2D 素材。

    只留目录名: 直链带 Expires/Signature, 不进日志/报告。
    """
    s = str(url or "")
    if not s:
        return ""
    try:
        from urllib.parse import urlsplit
        return urlsplit(s).path.lstrip("/").split("/")[0]
    except Exception:  # noqa: BLE001
        return ""


def _key_shape(value: Any) -> Any:
    """素材 key 的"形状"(可以转发的诊断粒度): 长度 + 前 6 位, 不留完整 key。"""
    s = str(value or "")
    if not s:
        return None
    return {"len": len(s), "prefix": s[:6]}


def zip_summary(blob: bytes) -> dict:
    """zip 的条目统计(探针用): 是不是有效 zip、有多少条目、前几十个名字。"""
    try:
        with zipfile.ZipFile(BytesIO(blob)) as zf:
            names = zf.namelist()
        return {"valid": True, "entries": len(names), "names": names[:60]}
    except Exception as err:  # noqa: BLE001  任何解析失败都只是"不是有效 zip"
        return {"valid": False, "note": f"{type(err).__name__}: {err}"[:160]}


def _write_report(dest: Path, report: dict) -> Path:
    path = dest / f"car3d_diag_{time.strftime('%Y%m%d_%H%M%S')}.json"
    try:
        path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError as err:
        log.warning("写 3D 诊断报告失败: %s", err)
    return path


def _extract_package(client: Any, vin: str, base: Path, key: str, what: str) -> None:
    """取一个素材包并解压; 失败时把 HTTP 响应形状一起挂进 detail(诊断用)。

    响应形状来自 `client.last_asset_meta`(见 api_client._asset_meta): 状态码 / 内容类型 /
    字节数 / 头部片段 —— 车主反馈的"下载失败"里, 靠这几项区分风控页 / 网关错误页 /
    登录页 / 换了格式。
    """
    blob = client.fetch_asset_zip(vin, key)
    if hit := _package_risk(blob):
        raise AssetError(hit, detail=f"{what}: 风控响应, 已停止下载")
    try:
        safe_extract(zip_bytes(blob, what), base)
    except AssetError as err:
        meta = getattr(client, "last_asset_meta", None) or {}
        if meta:
            err.detail = (err.detail + "; HTTP " + json.dumps(
                meta, ensure_ascii=False, sort_keys=True))[:600]
        raise


def _package_risk(blob: bytes) -> str:
    """素材接口也可能返回 JSON 风控响应；遇到它不能接着下载下一包。"""
    if blob.startswith(b"PK"):
        return ""
    try:
        return _risk_hit(json.loads(blob.decode("utf-8-sig")))
    except (ValueError, UnicodeError):
        return ""


def _data(resp: Any) -> dict:
    data = resp.get("data") if isinstance(resp, dict) else None
    return data if isinstance(data, dict) else {}


def _model_param(data: dict) -> dict:
    param = data.get("modelParam")
    return {k: v for k, v in param.items() if k in MODEL_PARAM_FIELDS} if isinstance(param, dict) else {}


def probe_extra(*, integration_version: str = "", car_type: str = "", sub_version: str = "",
                vin_fingerprint: str = "", ready: bool = False, status: dict | None = None,
                state: dict | None = None, energy_pref: str = "", latched: bool = False,
                signals: dict | None = None) -> dict:
    """组装探针报告里"集成侧"的那部分(HA 层把值取好传进来 —— 这里保持无 HA 依赖)。

    为什么要单独一个函数: 车主反馈的两类问题(3D 素材 / 增程判定)都**按车型而不同**,
    报告要把"我们这边的状态与判据"和"云端回了什么"放在一起才能对照着看 ——
    而这些取值逻辑(尤其增程判定链路)必须能离线单测, 不能只活在 service handler 里。
    """
    from .api import is_reev, reev_ranges          # 延迟相对导入(本模块要能离线单测)

    sig = dict(signals or {})
    stat = dict(status or {})
    for noisy in ("colors", "dir"):                # 色表很长/本机路径, 与故障无关
        stat.pop(noisy, None)
    return {
        "integration_version": str(integration_version or ""),
        "car_type": str(car_type or ""),
        "sub_version": str(sub_version or ""),
        "vin_fingerprint": str(vin_fingerprint or ""),
        "car3d": {
            "ready": bool(ready),
            "status": stat,
            "state": (state or {}).get("state"),
            "last_error": (state or {}).get("error") or "",
            "last_error_detail": (state or {}).get("detail") or "",
        },
        # 增程判定链路: 选项 → 是否记住 → 当前帧判据 → 三组续航值(车型差异多发在这里)
        "reev": {
            "pref": str(energy_pref or ""),
            "latched": bool(latched),
            "now": is_reev(sig),
            "ranges": reev_ranges(sig),
        },
    }


def probe_sync(client: Any, vin: str, dest: Path, *, extra: dict | None = None,
               deep: bool = False, variants: bool = True,
               sleeper: Callable[[float], None] = time.sleep) -> dict:
    """深度检查"这辆车的 3D 素材链路", 并生成可转发的报告。

    为什么需要它: 3D 素材的两类失败("3dkey 响应异常" / "file is not a zip")只在**个别
    车型**上出现, 本地无法复现(素材按 VIN 由服务端推导, 拿不到那辆车的帧)。与其猜,
    不如把"云端到底回了什么"一次记清楚。

    只读、带节流、命中风控即停(不重试):
      ① `3d/key` → 完整响应形状 + 车型参数(素材 key 只留长度与前缀);
      ② 每个素材包 → 状态码 / 内容类型 / 字节数 / 头部片段 + 是不是 zip;
         `deep=True` 时整包下载并列出条目, **不是有效 zip 的包存下来**(便于直接看内容);
      ③ `carpicture/key`(2D 外观图)→ 只看响应形状, 判断该车在云端有没有 2D 素材。

    报告写到 dest 下的 `car3d_diag_<时间>.json`(**不写 VIN、不写完整 key**)。
    """
    dest.mkdir(parents=True, exist_ok=True)
    report: dict[str, Any] = {
        "probed_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "deep": bool(deep),
        "variants": bool(variants),
        "requests": 0,
        **(extra or {}),
    }

    # ① 3D key(与官方 App 一致的参数集: deviceID + vin + osVersion)
    params = asset_params(client, vin)
    key3d = client.car_call("v3/api/carpicture/3d/key", params, method="GET")
    report["requests"] += 1
    report["key3d_params"] = sorted(params.keys())
    report["key3d_envelope"] = envelope(key3d)
    report["key3d_risk"] = _risk_hit(key3d) or ""
    if variants and not report["key3d_risk"]:
        # 对比"只发 vin"(旧写法)与"App 参数集"的响应 —— modelType 降级/车型差异就藏在这里;
        # 这正是车主"App 里有 3D、集成拿不到"这类反馈的判定依据。
        # ⚠️ 命中风控时**绝不再发**请求(下面会直接 return)。
        try:
            sleeper(THROTTLE_SECONDS)
            bare = client.car_call("v3/api/carpicture/3d/key", {"vin": vin}, method="GET")
            report["requests"] += 1
            d_full = _data(key3d)
            d_bare = _data(bare)
            report["key3d_variants"] = {
                "full(deviceID+vin+osVersion)": {
                    "envelope": envelope(key3d),
                    "model_type": d_full.get("modelType"),
                    "has_model_param": bool(d_full.get("modelParam")),
                },
                "bare(vin)": {
                    "envelope": envelope(bare),
                    "model_type": d_bare.get("modelType"),
                    "has_model_param": bool(d_bare.get("modelParam")),
                },
            }
            if hit := _risk_hit(bare):
                report["key3d_risk"] = hit
            elif not d_full.get("h5Key") and d_bare.get("h5Key"):
                key3d = bare
                report["effective_variant"] = "bare(vin)"
        except Exception as err:  # noqa: BLE001  对比失败不影响主流程
            report["key3d_variants"] = {"bare(vin) 请求失败": f"{type(err).__name__}: {err}"[:160]}
    data = _data(key3d)
    report["modelParam"] = _model_param(data)
    # 车型差异**只体现在响应内容**上(端点与参数各车型一致, 已核对 App 代码):
    # modelType 3=有 3D / 2=只有 2D(App 静默回退) / 1=无车模素材; 直链目录段同理
    # (carModel3D / carModelPicture)。这两项是"这辆车为什么用不了 3D"的关键证据。
    report["model_type"] = data.get("modelType")
    report["model_version"] = data.get("modelVersion")
    report["data_keys"] = sorted(data.keys()) if isinstance(data, dict) else []
    report["oss_dir"] = _oss_dir(data.get("shareBindUrl"))
    report["keys"] = {k: _key_shape(data.get(k)) for k in ("h5Key", "srcKey")}
    if report["key3d_risk"]:
        report["stopped"] = "风控命中, 未继续(不重试)"
        _write_report(dest, report)
        return report

    # ② 素材包(查看器 / 本车模型): 形状 + zip 校验; 异常包存下来
    packages: list[dict[str, Any]] = []
    for label, key_name in (("查看器包(h5Key)", "h5Key"), ("本车模型包(srcKey)", "srcKey")):
        key = str(data.get(key_name) or "")
        if not key:
            packages.append({"what": label, "skipped": "云端没给这个 key"})
            continue
        sleeper(THROTTLE_SECONDS)
        try:
            blob = client.fetch_asset_zip(vin, key, max_bytes=0 if deep else 65_536)
            report["requests"] += 1
            http = dict(getattr(client, "last_asset_meta", None) or {})
            item: dict[str, Any] = {"what": label, "key": _key_shape(key), "http": http}
            if hit := _package_risk(blob):
                item["risk"] = hit
                packages.append(item)
                report["stopped"] = "素材包返回风控, 未继续(不重试)"
                report["packages"] = packages
                _write_report(dest, report)
                return report
            if deep:
                item["zip"] = zip_summary(blob)
                if not item["zip"]["valid"]:
                    saved = dest / f"pkg_not_zip_{label.split('(')[0]}_{int(time.time())}.bin"
                    saved.write_bytes(blob)
                    item["saved"] = saved.name
            else:
                item["looks_zip"] = blob.startswith(b"PK")
            packages.append(item)
        except Exception as err:  # noqa: BLE001  探针不能因为单个包失败而中断
            report["requests"] += 1
            packages.append({"what": label, "key": _key_shape(key),
                             "error": f"{type(err).__name__}: {err}"[:200],
                             "http": dict(getattr(client, "last_asset_meta", None) or {})})
    report["packages"] = packages

    # ③ 2D 外观图: 只看响应形状(判断该车在云端有没有 2D 素材)
    sleeper(THROTTLE_SECONDS)
    try:
        pic = client.car_call("v3/api/carpicture/key", {"vin": vin}, method="GET")
        report["requests"] += 1
        report["car2d_envelope"] = envelope(pic)
        report["car2d_risk"] = _risk_hit(pic) or ""
        d2 = (pic or {}).get("data") or {}
        report["car2d_fields"] = sorted(d2.keys()) if isinstance(d2, dict) else []
    except Exception as err:  # noqa: BLE001
        report["car2d_error"] = f"{type(err).__name__}: {err}"[:200]

    _write_report(dest, report)
    return report


def _risk_hit(resp: Any) -> str:
    """云端风控/限流响应(code=1023)时返回提示文本。"""
    if not isinstance(resp, dict):
        return ""
    code = str(resp.get("code") if resp.get("code") is not None else "")
    msg = str(resp.get("msg") or resp.get("message") or "")
    if code in ("1023", "1024") or "频繁" in msg or "限制" in msg:
        return f"云端风控命中(code={code or '?'})"
    return ""


def envelope(resp: Any, limit: int = 120) -> str:
    """把一份接口响应压成"可上报、可检索"的一行特征 —— 不含敏感值。

    3d/key 失败时我们看不到车主的网络环境, 只有这一行能说明是"云端拒绝(code!=0)"
    还是"接受了但没内容(data 空)"。只取 code/result/message + data 的**形状**:
    message 是云端给的原因(截断), data 可能是带签名的长串(所以只记类型/键名/长度)。

    `modelType` / `modelVersion` 单独点名: 端点在 CN App 里**所有车型都一致**
    (三条 carpicture 路径各只有一处调用点, 参数恒为 vin/osVersion/deviceID), 车型差异
    只体现在**响应内容**上 —— 官方 App 就靠 `data.modelType` 分支(3=3D / 2=只有 2D /
    1=无素材, 见 MODEL_TYPE_*), 所以这两项是"这辆车为什么用不了 3D"的关键证据。
    """
    if not isinstance(resp, dict):
        return f"响应类型={type(resp).__name__}"
    parts = []
    for k in ("code", "result"):
        if resp.get(k) is not None:
            parts.append(f"{k}={resp[k]}")
    msg = str(resp.get("msg") or resp.get("message") or "").strip()
    if msg:
        parts.append(f"message={msg[:limit]!r}")
    data = resp.get("data")
    if data is None:
        parts.append("data=无")
    elif isinstance(data, dict):
        parts.append(f"data 键={sorted(data.keys())}")
        for k in ("modelType", "modelVersion"):
            if k in data:
                parts.append(f"{k}={data[k]!r}")
    elif isinstance(data, (list, str)):
        parts.append(f"data 类型={type(data).__name__}长度={len(data)}")
    else:
        parts.append(f"data 类型={type(data).__name__}")
    return ", ".join(parts)


def zip_bytes(blob: bytes, what: str) -> bytes:
    """校验素材包字节, 把"不是 zip"转成可读的中文失败(带诊断细节)。

    实测车主反馈: 云端有时会用一个 200 的 JSON/HTML 代替素材包(未开通 / 风控 /
    网关拦截), 原样交给 zipfile 只会抛英文的 "File is not a zip file" ——
    既看不懂也无从定位。这里顺带容错 gzip 包裹(zip 前面套一层 gzip 的情况)。
    """
    if not blob:
        raise AssetError(f"{what}为空(云端返回 0 字节)", detail=f"{what}: 0 字节")
    if blob[:2] == b"\x1f\x8b":                     # gzip magics: 少数网关会套一层
        try:
            blob = gzip.decompress(blob)
        except OSError as err:
            raise AssetError(f"{what}解压失败(响应是 gzip 但不是有效数据)",
                             detail=f"{what}: gzip 解压失败: {err}") from err
    if not blob.startswith(b"PK"):
        head = "".join(chr(b) if 32 <= b < 127 else "." for b in blob[:48])
        raise AssetError(
            f"{what}不是压缩包(云端返回了 {len(blob)} 字节的非 zip 内容)",
            detail=f"{what}: {len(blob)} 字节, 头部(可打印)= {head!r}")
    if not zipfile.is_zipfile(BytesIO(blob)):
        raise AssetError(f"{what}下载不完整(缺少 zip 结尾记录)", detail=f"{what}: {len(blob)} 字节")
    return blob


def _key3d_has_payload(resp: Any) -> bool:
    """3d/key 的响应里到底有没有内容(决定"换参数再试一次"值不值得)。"""
    if not isinstance(resp, dict):
        return False
    data = resp.get("data")
    if not isinstance(data, dict) or not data:
        return False
    return any(bool(data.get(k))
               for k in ("modelParam", "h5Key", "srcKey", "modelType", "modelVersion"))


def fetch_key3d(client: Any, vin: str, *,
                sleeper: Callable[[float], None] = time.sleep) -> tuple[Any, str]:
    """取 `3d/key`,返回 `(响应, 参数说明)`。

    先按**官方 App 的参数**(`deviceID + vin + osVersion`,见 `asset_params`);只有在
    **什么都没拿到**时,才退回旧写法(只发 `vin`)再试一次。这一步是保险而不是证据:
    对齐参数只是为了让请求形状与官方客户端一致, **"osVersion 影响云端给不给 3D"这个推断
    存疑且未验证**, 所以我们保证"最坏也不会比改之前更差"。正常路径永远只有 1 个请求;
    命中风控则**绝不**再发第二个(退一步的响应本身是风控时, 照原样返回给上层)。
    """
    app_resp = client.car_call("v3/api/carpicture/3d/key", asset_params(client, vin), method="GET")
    if _key3d_has_payload(app_resp) or _risk_hit(app_resp):
        return app_resp, "App 参数(deviceID+vin+osVersion)"
    sleeper(THROTTLE_SECONDS)
    bare = client.car_call("v3/api/carpicture/3d/key", {"vin": vin}, method="GET")
    if _key3d_has_payload(bare) or _risk_hit(bare):
        # 风控响应也要照原样返回(上层据此报"风控命中"并停止), 不能因为"没内容"就丢掉
        return bare, "只发 vin(App 参数无内容时回退)"
    return app_resp, "App 参数/只发 vin 都无内容"


def assemble_sync(client: Any, vin: str, base: Path,
                  wrapper: Path | None = None, *,
                  sleeper: Callable[[float], None] = time.sleep,
                  force: bool = False) -> dict:
    """把"查看器 + 本车模型 + 包装页"装配到 base(阻塞式)。

    幂等: 需要的部分已经落盘就不再联网, 所以卡片每次打开都调它也不会产生请求。
    只有 `force=True` 或设备/版本变化(见 needs_fetch)才会真的走网络。
    """
    base.mkdir(parents=True, exist_ok=True)
    man = read_manifest(base)
    param = (man.get("model") or {}).get("param") or {}
    installed = install_wrapper(base, wrapper or wrapper_src())   # 内部会同步 manifest 版本号

    st = status(base)
    if not force and st["viewer"] and st["model"]:
        st["changed"] = bool(installed)
        st["colors"] = st["colors"] or colors_of(
            base, st["car_type"], st["year"], param.get("carTypeCode") or "")
        st["ready"] = True
        return st

    key3d, param_note = fetch_key3d(client, vin, sleeper=sleeper)
    hit = _risk_hit(key3d)
    if hit:
        raise AssetError(hit, detail=f"3d/key: {envelope(key3d)}")
    payload = _data(key3d)
    model_param = _model_param(payload)
    h5_key, src_key = str(payload.get("h5Key") or ""), str(payload.get("srcKey") or "")
    # 参数说明进 detail: 车主反馈里"App 有 3D、集成拿不到"是不是参数导致的, 一眼可判
    detail = f"{envelope(key3d)}; 参数={param_note}"
    model_type = payload.get("modelType")
    # 云端用 modelType 声明这辆车有什么素材 —— 官方 App 照它分支(见 MODEL_TYPE_*)。
    # 2/1 都不是故障: 说清楚是什么, 并记到 manifest 里(卡片下次打开直接显示, 不用再试一次)。
    if model_type == MODEL_TYPE_2D:
        # ⚠️ 不要写成"这辆车没有 3D 素材": 车主已证实 C11 在官方 App 里是有 3D 的 ——
        # modelType=2 只说明**这次**没下发(可能是按客户端声明/能力降级)。所以这里只陈述
        # "这次拿到了什么", 并把请求参数与响应形状一起交出去(探针报告可直接对比两种请求)。
        raise AssetError("云端这次没有下发 3D 素材(只返回了 2D 模式)",
                         detail=detail, unsupported=True, model_type=model_type)
    if model_type == MODEL_TYPE_NONE:
        raise AssetError("云端没有这辆车的车模素材",
                         detail=detail, unsupported=True, model_type=model_type)
    if not model_param.get("carType"):
        log.warning("3d/key 响应里没有车型参数: %s", detail)
        # 空响应不能证明车型不支持；保留报文形状，等车主的诊断样本判断。
        raise AssetError("云端没有返回这辆车的 3D 车型参数，请导出诊断以确认原因",
                         detail=f"3d/key: {detail}")
    car_type, year = model_param.get("carType"), model_param.get("year")
    car_type_code = model_param.get("carTypeCode") or ""
    need_viewer = force or not viewer_ready(base)
    need_model = force or not model_ready(base, car_type, year, car_type_code)

    fetched = 0
    if need_viewer:
        if not h5_key:
            raise AssetError("云端未返回查看器素材 key", detail=f"3d/key: {detail}")
        _extract_package(client, vin, base, h5_key, "查看器素材包")
        fetched += 1
    if need_model:
        if not src_key:
            raise AssetError("云端未返回车型模型 key", detail=f"3d/key: {detail}")
        sleeper(THROTTLE_SECONDS if fetched else 0)
        _extract_package(client, vin, base, src_key, "车型模型包")
        fetched += 1

    install_wrapper(base, wrapper or wrapper_src())
    if not viewer_ready(base) or not model_ready(base, car_type, year, car_type_code):
        raise AssetError("素材包内缺少查看器或对应车型模型，请运行深度诊断",
                         detail=f"期望 index.js 与 {model_prefix(car_type, year, car_type_code)}/*_car.fbx")
    colors = colors_of(base, car_type, year, car_type_code)
    write_manifest(base, {
        "asset_version": ASSET_VERSION,
        "vin_fingerprint": _vin_fingerprint(vin),
        "key3d_params": param_note,
        "fetched_at": time.time(),
        "model": {"car_type": car_type, "year": year,
                  "param": model_param},
        "colors": colors,
        "files": {"viewer": viewer_ready(base),
                  "model": model_ready(base, car_type, year, car_type_code)},
    })
    st = status(base)
    st["changed"] = True
    st["fetched"] = fetched
    st["ready"] = ready(base)
    st["colors"] = colors or st["colors"]
    log.info("3D 车模素材已装配: %s %s (下载 %d 个包)", car_type, year, fetched)
    return st


# ── HA 层: 状态机 + 后台任务(卡片轮询 info, 需要时点一下 ensure) ──────
STATE_KEY = "_car3d"
PROFILES_KEY = "_car3d_profiles"
_EMPTY_STATE: dict = {"state": "idle", "error": "", "detail": "", "last_try": 0.0, "task": None}


def _state(hass: HomeAssistant, coord: Any = None) -> dict:
    data = hass.data.setdefault(_domain(), {})
    if coord is None:
        return data.setdefault(STATE_KEY, dict(_EMPTY_STATE))
    key = _vin_fingerprint(str(getattr(coord, "vin", "") or "")) or str(
        getattr(getattr(coord, "entry", None), "entry_id", "unknown"))
    return data.setdefault(PROFILES_KEY, {}).setdefault(key, dict(_EMPTY_STATE))


async def async_info(hass: HomeAssistant, coord: Any = None) -> dict:
    """给卡片的现状(不联网): 素材是否就绪 + 车型参数 + 车型色表 + 用户选项。"""
    base = profile_root(hass, coord) if coord is not None else root(hass)
    st = await hass.async_add_executor_job(status, base)
    if st["model"] and not st["colors"]:
        st["colors"] = await hass.async_add_executor_job(
            colors_of, base, st["car_type"], st["year"],
            st["model_param"].get("carTypeCode") or "")
    st["ready"] = bool(st["viewer"] and st["model"])
    opts = dict(getattr(getattr(coord, "entry", None), "options", {}) or {})
    st["options"] = {k: opts.get(k) for k in ("car3d_color", "car3d_bg", "car3d_image")}
    relative = base.relative_to(root(hass)).as_posix()
    suffix = f"{relative}/" if relative != "." else ""
    st["base_url"] = f"/leapmotor-card/{URL_DIR}/{suffix}view.html"
    state = _state(hass, coord)
    st["state"] = state["state"]
    st["error"] = state["error"]
    st["detail"] = state.get("detail") or ""
    # 运行期没在报错时, 把 manifest 里记着的"云端没有 3D 素材"拿出来显示 ——
    # 这条结论不会因为重启/换浏览器而消失, 也不必让车主再点一次下载去发现它。
    if st["state"] in ("idle", "") and not st["ready"] and not st["error"]:
        uns = st.get("unsupported") or {}
        if uns:
            st["state"] = "unsupported"
            st["error"] = str(uns.get("reason") or "")
    return st


async def async_ensure(hass: HomeAssistant, coord: Any, *, force: bool = False) -> dict:
    """确保素材就绪: 需要就起一个后台装配任务, 立刻返回当前状态(卡片再轮询 info)。"""
    state = _state(hass, coord)
    if state["state"] == "downloading":
        return {"state": "downloading", "started": False}
    base = profile_root(hass, coord)
    if not force:
        if await hass.async_add_executor_job(ready, base):
            return {"state": "ready", "started": False}
        now = time.time()
        if state["last_try"] and now - state["last_try"] < COOLDOWN_SECONDS:
            return {"state": "error", "started": False,
                    "error": state["error"] or "刚失败过, 稍后再试"}

    state.update({"state": "downloading", "error": "", "detail": "", "last_try": time.time()})

    async def _run() -> None:
        try:
            # async_add_executor_job 不支持关键字参数 → 用 partial 绑好 sleeper/force
            job = functools.partial(assemble_sync, coord.client, coord.vin, base,
                                    None, sleeper=time.sleep, force=force)
            await hass.async_add_executor_job(job)
            state["state"] = "ready"
        except Exception as err:  # noqa: BLE001  网络/素材异常都退化成"用不了 3D", 不影响卡片其余功能
            unsupported = bool(getattr(err, "unsupported", False))
            state["state"] = "unsupported" if unsupported else "error"
            state["error"] = str(err)[:200]
            # detail 是给"车主上报问题"用的(进诊断文件): 云端响应的形状 / 字节特征,
            # 不含 VIN 与签名 —— 没有它就只能收到一句"下载失败", 无从定位。
            state["detail"] = str(getattr(err, "detail", "") or "")[:600]
            if unsupported:
                # 只有 modelType=1(云端确实没有这辆车的车模素材)才落盘粘住;
                # =2 只是"这次没下发"(可能是按客户端声明降级), 不写成永久结论 ——
                # 换个参数或云端调整后可能就好了, 车主也不该看到一条过期的断言。
                if getattr(err, "model_type", None) == MODEL_TYPE_NONE:
                    await hass.async_add_executor_job(
                        note_unsupported, base, MODEL_TYPE_NONE, state["error"])
                    log.info("云端没有这辆车的车模素材: %s | %s", err, state["detail"])
                else:
                    log.info("云端这次未下发 3D 素材(modelType=%s): %s",
                             getattr(err, "model_type", None), state["detail"])
            else:
                log.warning("3D 车模素材装配失败: %s%s",
                            err, f" | 详情: {state['detail']}" if state["detail"] else "")

    state["task"] = hass.async_create_task(_run())
    return {"state": "downloading", "started": True}


async def async_reset(hass: HomeAssistant) -> None:
    """清掉装配状态(配置条目重载时调用, 让"失败冷却"不会跨重载粘住)。"""
    data = hass.data.get(_domain())
    if isinstance(data, dict):
        data.pop(STATE_KEY, None)
        data.pop(PROFILES_KEY, None)
