"""防回归: 会话提醒**只在续期失败时**发出, 不许再有"快到期"预提醒(太吵)。

背景: 曾有一条「登录会话快到期」的预提醒, 吓人但实属虚惊 —— 账号 token 有免短信续期
通道(refreshToken 不轮换、可无限续, 实测 `code=200`), 提前 30 分钟的预提醒纯属噪音:
它发出约十分钟后系统自己就把 token 续上了, 期间功能一直正常。

正确设计:
  * **续期失败且服务端已拒收** → `_warn_expired()` 发一条「需要重新认证」(id
    `leapmotor_session_expired`);
  * 会话恢复健康 → `_clear_stale_session_notices()` 自动撤掉提醒并复位标记;
  * 老概念的「登录会话快到期」(id `leapmotor_session_expiry`)**只清不发**。
"""
from __future__ import annotations

import pathlib
import re

PKG = pathlib.Path(__file__).resolve().parent.parent / "custom_components" / "leapmotor"


def test_no_pre_expiry_warning_remains():
    src = (PKG / "coordinator.py").read_text(encoding="utf-8")
    assert "_warn_before_expiry" not in src, (
        "预提醒已删除：账号 token 平时会被静默续期，提前提醒是噪音；"
        "只在真的续期失败时才提醒（见 _warn_expired）"
    )
    # 旧通知**标题**不许再出现(注释里提到旧概念没关系, 那是清理逻辑的说明)
    assert '"零跑汽车: 登录会话快到期"' not in src


def test_expired_warning_mentions_refresh_failure():
    src = (PKG / "coordinator.py").read_text(encoding="utf-8")
    m = re.search(r"async def _warn_expired.*?notification_id", src, re.S)
    assert m, "找不到 _warn_expired 的通知登记"
    body = m.group(0)
    assert "自动续期失败" in body, "提醒必须说明是'续期失败'(而不是'快到期'), 避免虚惊"


def test_warning_is_cleared_when_session_recovers():
    src = (PKG / "coordinator.py").read_text(encoding="utf-8")
    assert "_clear_stale_session_notices" in src, "会话恢复要能自动清掉残留提醒"
    # 清理逻辑必须区分"会话真健康"与"账号死了但车端还活着"(后者不许撤提醒)
    m = re.search(r"async def _clear_stale_session_notices.*?(?=\n    # ──|\nasync def|\n    def )",
                  src, re.S)
    assert m and "if not self.session_problem" in m.group(0), (
        "只有会话真健康时才撤'需重新认证'提醒; 车端 token 仍有效时撤掉等于没提醒"
    )
