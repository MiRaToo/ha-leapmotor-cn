"""短暂保留已受理的充电计划修改；收到一致回报或超时后交回云端。"""
from __future__ import annotations

FIELDS = {"percent", "isEnable", "beginTime", "endTime", "cycles", "circulation", "recharge"}


def effective_plan(raw: dict, pending: dict, now: float) -> dict:
    plan = dict(raw)
    for key, (value, until) in list(pending.items()):
        actual = plan.get(key)
        try:
            same = float(actual) == float(value) if key in {"percent", "isEnable", "circulation", "recharge"} else str(actual) == str(value)
        except (ValueError, TypeError):
            same = False
        if now >= until or same:
            pending.pop(key, None)
        else:
            plan[key] = value
    return plan
