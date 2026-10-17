"""正式集成的素材采集与诊断服务及其只读边界。"""
from __future__ import annotations

import ast
import pathlib

PKG = pathlib.Path(__file__).resolve().parent.parent / "custom_components" / "leapmotor"


def _init_tree() -> tuple[str, ast.Module]:
    src = (PKG / "__init__.py").read_text(encoding="utf-8")
    return src, ast.parse(src)


def test_asset_services_register_during_setup():
    """HA 集成启动时注册素材服务，不依赖实验版版本号门控。"""
    src, tree = _init_tree()
    setup = next(node for node in tree.body
                 if isinstance(node, ast.AsyncFunctionDef) and node.name == "async_setup")
    calls = [
        node for node in ast.walk(setup)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "async_register_asset_services"
    ]
    assert calls, "__init__.py 的 async_setup 必须注册素材服务"
    assert "is_lab_build" not in src, "正式版服务注册不应再由实验版版本号门控"


def test_collect_service_is_readonly_and_throttled():
    """素材采集只读取云端并遵守请求节流与风控停止条件。"""
    src = (PKG / "asset_services.py").read_text(encoding="utf-8")
    assert 'method="GET"' in src
    for bad in ("remote_control", "CMD_", "unlock", "lock(", "ac_on"):
        assert bad not in src, f"素材服务里出现了疑似车控写法: {bad}"
    assert "RISK_KEYWORDS" in src and "THROTTLE_S" in src


def test_services_are_declared_and_registered():
    """HA 服务声明与代码注册的服务名保持一致。"""
    import yaml

    declared = yaml.safe_load((PKG / "services.yaml").read_text(encoding="utf-8")) or {}
    source = (PKG / "asset_services.py").read_text(encoding="utf-8")
    for name in ("collect_assets", "car3d_probe"):
        assert name in declared, f"services.yaml 里没有声明服务 {name}"
        assert f'"{name}"' in source, f"asset_services.py 没有注册服务 {name}"


def test_car3d_probe_is_readonly():
    """3D 探针只读，不得包含车控或 POST 写操作。"""
    src = (PKG / "car3d.py").read_text(encoding="utf-8")
    probe = src[src.index("def probe_sync"):src.index("def _risk_hit")]
    for bad in ("remote_control", "car_control", 'method="POST"', "method='POST'"):
        assert bad not in probe, f"3D 探针里出现了非只读写法: {bad}"


def test_asset_service_module_only_calls_existing_names():
    """素材模块调用的 car3d 与 API 名称必须在目标模块中存在。"""
    def defined_names(path: pathlib.Path) -> set[str]:
        tree = ast.parse(path.read_text(encoding="utf-8"))
        out: set[str] = set()
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                out.add(node.name)
            elif isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        out.add(target.id)
            elif isinstance(node, (ast.Import, ast.ImportFrom)):
                for alias in node.names:
                    out.add(alias.asname or alias.name.split(".")[0])
        return out

    source = (PKG / "asset_services.py").read_text(encoding="utf-8")
    definitions = defined_names(PKG / "asset_services.py")
    tree = ast.parse(source)
    for module_name, target in (("car3d", PKG / "car3d.py"), ("_api", PKG / "api.py")):
        known = defined_names(target)
        used = {
            node.attr for node in ast.walk(tree)
            if isinstance(node, ast.Attribute)
            and isinstance(node.value, ast.Name)
            and node.value.id == module_name
        }
        missing = sorted(used - known)
        assert not missing, f"asset_services.py 调用了 {module_name} 中不存在的名称: {missing}"
    assert "probe_sync" in (PKG / "car3d.py").read_text(encoding="utf-8")
    assert "is_lab_build" not in definitions
