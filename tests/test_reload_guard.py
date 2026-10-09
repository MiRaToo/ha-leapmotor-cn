"""防回归: 集成不得再注册"条目更新就重载"的监听器(重载风暴根因)。

真机实测: 集成每 ~2 小时把续期后的 token 写回条目(data 变化), 而 HA 的
update listener 在**任何**条目变化(含仅 data)时都会触发 —— 原来的监听器无条件
`async_reload` —— 结果每天几十次整批实体同时 unavailable(某日 49 个实体同秒掉线
≥39 次, 实为长期问题, 近一周天天如此)。

正确设计(HA 源码里二者明确互斥, 见 OptionsFlowWithReload 的 docstring):
  * 选项变更 → `OptionsFlowWithReload` 保存后自动重载;
  * 重新认证 → 认证流程自己调度一次重载(`async_update_reload_and_abort`);
  * token 落盘 → **不触发任何重载**。
"""
from __future__ import annotations

import pathlib
import re

PKG = pathlib.Path(__file__).resolve().parent.parent / "custom_components" / "leapmotor"


def test_no_update_listener_registered():
    src = (PKG / "__init__.py").read_text(encoding="utf-8")
    code = re.sub(r"#[^\n]*", "", src)     # 注释里提到它没关系, 只禁真调用
    assert "add_update_listener(" not in code, (
        "不要注册条目更新监听器 —— 集成把 token 落盘时它也会触发重载, "
        "造成整批实体反复 unavailable; 选项变更交给 OptionsFlowWithReload"
    )


def test_options_flow_uses_automatic_reload():
    src = (PKG / "config_flow.py").read_text(encoding="utf-8")
    assert "OptionsFlowWithReload" in src, "选项流程必须用 OptionsFlowWithReload(保存后自动重载)"


def test_reauth_still_schedules_its_own_reload():
    src = (PKG / "config_flow.py").read_text(encoding="utf-8")
    assert "async_update_reload_and_abort" in src, (
        "重新认证写回新会话后要由流程调度一次重载(此时已无 update listener)"
    )
