"""执行协调器的实际确认任务，不联网、不调用车辆控制，也不等待真实三分钟。"""
import ast
import asyncio
import logging
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import api_client


def confirmation_runtime(monkeypatch):
    now = [1_800_000_000.0]
    monkeypatch.setattr(api_client.time, "time", lambda: now[0])
    source = Path(__file__).resolve().parents[1] / "custom_components/leapmotor/coordinator.py"
    tree = ast.parse(source.read_text(encoding="utf-8"))
    original = next(node for node in tree.body
                    if isinstance(node, ast.ClassDef) and node.name == "LeapmotorCoordinator")
    names = {"remember", "confirmation_pending", "_schedule_control_confirmation",
             "_cancel_control_confirmation", "_watch_control_confirmations",
             "_refresh_control_for_confirmation"}
    # 加载生产方法，移除的只有 HA 基类和无关模块依赖。
    cls = ast.ClassDef(name="Runtime", bases=[], keywords=[], decorator_list=[],
                      body=[node for node in original.body if getattr(node, "name", None) in names])
    module = ast.fix_missing_locations(ast.Module(body=[cls], type_ignores=[]))

    async def sleep(delay):
        now[0] += max(delay, .001)
        await asyncio.sleep(0)

    namespace = {"Any": Any, "time": api_client.time, "log": logging.getLogger(__name__),
                 "asyncio": SimpleNamespace(sleep=sleep, current_task=asyncio.current_task,
                                            CancelledError=asyncio.CancelledError)}
    exec(compile(module, str(source), "exec"), namespace)
    coordinator = namespace["Runtime"]()
    coordinator.overrides = api_client.StateOverrides()
    coordinator.state = SimpleNamespace(collect_time=int(now[0] * 1000))
    coordinator._control_confirmation_task = None
    coordinator._control_confirmation_refresh_tasks = set()
    coordinator._rate_limited_until = 0
    coordinator.hass = SimpleNamespace(
        async_create_background_task=lambda coro, _name: asyncio.create_task(coro))
    notifications = []
    coordinator.async_update_listeners = lambda: notifications.append(now[0])
    return coordinator, now, notifications


def test_slow_refresh_does_not_stack_or_delay_timeout(monkeypatch):
    coordinator, now, notifications = confirmation_runtime(monkeypatch)

    async def scenario():
        started = now[0]
        calls = []
        gate = asyncio.Event()

        async def refresh():
            calls.append(now[0])
            await gate.wait()

        coordinator.async_request_refresh = refresh
        coordinator._control_actual = lambda _key: False
        coordinator.remember("windows", True)
        await coordinator._control_confirmation_task
        assert len(calls) == 1, "慢请求未完成时不能继续排队刷新"
        assert 180 <= now[0] - started < 180.1
        assert coordinator.overrides.unconfirmed_commands() == {"windows": True}
        assert coordinator.overrides.recall("windows") is None
        assert notifications, "没有新车况时也必须把超时结果推送给 HA"
        tasks = tuple(coordinator._control_confirmation_refresh_tasks)
        coordinator._cancel_control_confirmation()
        await asyncio.gather(*tasks, return_exceptions=True)
        assert all(task.cancelled() for task in tasks)

    asyncio.run(scenario())


def test_new_command_supersedes_old_wait_and_confirms_early(monkeypatch):
    coordinator, now, notifications = confirmation_runtime(monkeypatch)

    async def scenario():
        actual = [True]

        async def refresh():
            actual[0] = False
            coordinator.state.collect_time = int(now[0] * 1000) + 1

        coordinator.async_request_refresh = refresh
        coordinator._control_actual = lambda _key: actual[0]
        coordinator.remember("windows", True)
        old_task = coordinator._control_confirmation_task
        coordinator.remember("windows", False)
        new_task = coordinator._control_confirmation_task
        await new_task
        await asyncio.gather(old_task, return_exceptions=True)
        assert old_task.cancelled()
        assert coordinator.overrides.confirmation_result("windows") == "confirmed"
        assert coordinator.overrides.pending_confirmations() == {}
        assert coordinator.overrides.unconfirmed_commands() == {}
        assert coordinator.overrides.recall("windows") is None
        assert now[0] < 1_800_000_120, "吻合采样不应等满宽限期"
        assert notifications
        coordinator._cancel_control_confirmation()

    asyncio.run(scenario())


def test_confirmation_respects_rate_limit_and_unload(monkeypatch):
    coordinator, now, _notifications = confirmation_runtime(monkeypatch)

    async def scenario():
        calls = []

        async def refresh():
            calls.append(True)

        coordinator.async_request_refresh = refresh
        coordinator._control_actual = lambda _key: None
        coordinator._rate_limited_until = now[0] + 600
        coordinator.remember("lock", True)
        await coordinator._control_confirmation_task
        assert not calls
        assert coordinator.overrides.confirmation_result("lock") == "unconfirmed"
        coordinator.remember("lock", False)
        task = coordinator._control_confirmation_task
        coordinator._cancel_control_confirmation()
        await asyncio.gather(task, return_exceptions=True)
        assert task.cancelled()
        assert coordinator._control_confirmation_task is None

    asyncio.run(scenario())
