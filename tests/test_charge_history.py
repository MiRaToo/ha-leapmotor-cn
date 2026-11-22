"""Offline tests for the persistent charge history index."""
from __future__ import annotations

import asyncio
import copy
import pathlib
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "custom_components" / "leapmotor"))
sys.path.insert(0, str(ROOT / "poller"))

from charge_history import (  # noqa: E402
    ChargeHistoryIndex,
    CHARGE_HISTORY_SNAPSHOT_TTL_SECONDS,
)
from charging import ChargeRecorder  # noqa: E402
from api_client import CarState  # noqa: E402

ZONE = ZoneInfo("Asia/Hong_Kong")


class MemoryStore:
    def __init__(self):
        self.data = None

    async def async_load(self):
        return copy.deepcopy(self.data)

    async def async_save(self, data):
        self.data = copy.deepcopy(data)

    def async_delay_save(self, function, delay):
        self.data = copy.deepcopy(function())


def stamp(value: str) -> float:
    return datetime.fromisoformat(value).replace(tzinfo=ZONE).timestamp()


def session(record_id: str, start: float, hours: float = 1, *,
            kwh: float | None = 7.5, partial: bool = False,
            cost: float | None = 3.25, override: dict | None = None,
            sources: list[str] | None = None,
            ended: bool = True) -> dict:
    end = start + hours * 3600
    return {
        "id": record_id,
        "started_at": start,
        "ended_at": end if ended else None,
        "last_at": end,
        "soc_start": 30,
        "soc_end": 45,
        "kwh": kwh,
        "grid_kwh": kwh / .9 if kwh is not None else None,
        "cost": cost,
        "price_override": override,
        "sources": sources if sources is not None else (["power"] if kwh is not None else []),
        "active": not ended,
        "charge_type": "dc",
        "peak_kw": 80,
        "average_kw": 70,
        "partial": partial,
    }


def index(store=None, *, clock=None):
    return ChargeHistoryIndex(
        None, " test-vin ", store=store or MemoryStore(),
        now=clock or (lambda: stamp("2026-10-31T12:00:00")),
    )


def run(coro):
    return asyncio.run(coro)


def test_index_bootstraps_conservatively_and_does_not_claim_old_400_cap_range():
    now = stamp("2026-10-31T12:00:00")
    idx = index(clock=lambda: now)
    changed = idx.reconcile_sessions([
        session("old", stamp("2026-06-01T10:00:00")),
        session("recent", stamp("2026-10-30T10:00:00")),
    ], observed_at_ms=int(now * 1000))
    assert changed == 2
    old = idx.query("scope-a", int(stamp("2026-01-01T00:00:00") * 1000),
                    int(stamp("2026-10-30T23:59:59") * 1000), limit=1)
    assert old["coverage"] == "partial"
    assert old["coverage_reason"] == "range_may_predate_index_start"
    assert old["retention"]["legacy_backfill_coverage"] == "partial"
    assert old["retention"]["truncated_before_ms"] is None
    assert old["retention"]["reason"] == "pre_index_400_cap_records_are_unrecoverable"
    future = idx.query(
        "scope-a", int(now * 1000), int(now * 1000) + 1000, limit=100)
    assert future["coverage"] == "complete"
    assert future["coverage_reason"] == "range_after_index_start"
    assert future["rows"] == []


def test_query_supports_multi_year_retained_rows_and_stable_immutable_pagination():
    now = stamp("2026-10-31T12:00:00")
    idx = index(clock=lambda: now)
    rows = [session(f"c{i:03d}", stamp(f"2025-{1 + i % 12:02d}-{1 + i % 27:02d}T10:00:00"))
            for i in range(205)]
    idx.reconcile_sessions(rows, observed_at_ms=int(now * 1000))
    first = idx.query(
        "scope-a", int(stamp("2024-01-01T00:00:00") * 1000),
        int(now * 1000), limit=100,
    )
    second = idx.query(
        "scope-a", 0, 0, limit=100, page_token=first["next_page_token"])
    third = idx.query(
        "scope-a", 0, 0, limit=100, page_token=second["next_page_token"])
    assert first["record_count"] == 205
    assert len(first["rows"]) == len(second["rows"]) == 100
    assert len(third["rows"]) == 5
    assert third["has_more"] is False and third["next_page_token"] is None
    assert len({row["record_id"] for row in
                first["rows"] + second["rows"] + third["rows"]}) == 205
    assert first["snapshot_id"] == second["snapshot_id"] == third["snapshot_id"]
    assert first["dataset_epoch"] == third["dataset_epoch"]


def test_revision_and_new_query_change_do_not_mutate_an_open_snapshot():
    now = stamp("2026-10-31T12:00:00")
    idx = index(clock=lambda: now)
    idx.reconcile_sessions([session("same", stamp("2026-10-30T10:00:00"))],
                           observed_at_ms=int(now * 1000))
    first = idx.query("scope-a", int(stamp("2026-10-30T00:00:00") * 1000),
                      int(now * 1000), limit=1)
    original = copy.deepcopy(first["rows"][0])
    idx.upsert_session(session("same", stamp("2026-10-30T10:00:00"), kwh=9.0),
                       observed_at_ms=int((now + 10) * 1000))
    current = idx.query("scope-a", int(stamp("2026-10-30T00:00:00") * 1000),
                        int(now * 1000), limit=1)
    assert current["rows"][0]["row_revision"] == original["row_revision"] + 1
    assert current["rows"][0]["energy"]["kwh"] == 9.0
    assert current["generation"] > first["generation"]
    assert first["rows"][0] == original


def test_snapshot_expiry_tampering_cross_scope_and_missing_pages_fail_closed():
    now = stamp("2026-10-31T12:00:00")
    idx = index(clock=lambda: now)
    idx.reconcile_sessions([
        session("a", stamp("2026-10-30T10:00:00")),
        session("b", stamp("2026-10-30T11:00:00")),
    ], observed_at_ms=int(now * 1000))
    first = idx.query("scope-a", 0, int(now * 1000), limit=1)
    token = first["next_page_token"]
    with pytest.raises(ValueError, match="invalid_cursor"):
        idx.query("scope-a", 0, 0, limit=1, page_token=token[:-1] + "x")
    with pytest.raises(ValueError, match="invalid_cursor"):
        idx.query("scope-b", 0, 0, limit=1, page_token=token)
    now += CHARGE_HISTORY_SNAPSHOT_TTL_SECONDS + 1
    with pytest.raises(ValueError, match="snapshot_expired"):
        idx.query("scope-a", 0, 0, limit=1, page_token=token)


def test_delete_tombstone_survives_restart_and_absence_is_not_bulk_prune():
    now = stamp("2026-10-31T12:00:00")
    store = MemoryStore()
    idx = index(store, clock=lambda: now)
    idx.reconcile_sessions([
        session("one", stamp("2026-10-30T10:00:00")),
        session("two", stamp("2026-10-30T11:00:00")),
    ], observed_at_ms=int(now * 1000))
    assert idx.delete("one", observed_at_ms=int(now * 1000) + 1) is True
    idx.reconcile_sessions([session("two", stamp("2026-10-30T11:00:00"))],
                           observed_at_ms=int(now * 1000) + 2)

    async def restore():
        restored = index(store, clock=lambda: now + 5)
        await restored.async_load()
        return restored

    restored = run(restore())
    assert "one" not in restored.rows and "one" in restored.tombstones
    assert restored.tombstones["one"]["row_revision"] >= 2
    result = restored.query("scope-a", 0, int((now + 5) * 1000), limit=100)
    assert [row["record_id"] for row in result["rows"]] == ["two"]


def test_rows_preserve_zero_unknown_basis_estimate_and_active_phase():
    now = stamp("2026-10-31T12:00:00")
    idx = index(clock=lambda: now)
    idx.reconcile_sessions([
        session("zero", stamp("2026-10-30T08:00:00"), kwh=0,
                sources=["soc"], cost=0),
        session("unknown", stamp("2026-10-30T09:00:00"), kwh=None, cost=None,
                sources=[]),
        session("manual-total", stamp("2026-10-30T10:00:00"), kwh=0,
                sources=[], cost=12.5,
                override={"mode": "total", "value": 12.5}),
        session("recording", stamp("2026-10-31T11:00:00"), kwh=None,
                cost=None, sources=[], ended=False),
    ], observed_at_ms=int(now * 1000))
    result = idx.query("scope-a", 0, int(now * 1000), limit=10)
    rows = {row["record_id"]: row for row in result["rows"]}
    assert rows["zero"]["energy"]["kwh"] == 0
    assert rows["zero"]["money"]["amount"] == 0
    assert rows["zero"]["energy"]["basis"] == "battery_vehicle_estimate"
    assert rows["unknown"]["energy"]["kwh"] is None
    assert rows["unknown"]["energy"]["coverage"] == "unavailable"
    assert rows["manual-total"]["money"] == {
        "amount": 12.5, "currency": "CNY",
        "basis": "manual_total_estimate", "evidence": "estimated",
    }
    assert rows["recording"]["phase"] == "recording"
    assert rows["recording"]["energy"]["coverage"] == "unavailable"


def test_persistent_epoch_sequence_and_revision_do_not_reset_on_restart():
    now = stamp("2026-10-31T12:00:00")
    store = MemoryStore()
    first = index(store, clock=lambda: now)
    first.reconcile_sessions([session("same", stamp("2026-10-30T10:00:00"))],
                             observed_at_ms=int(now * 1000))
    epoch = first.dataset_epoch
    seq = first.change_seq
    first.upsert_session(session("same", stamp("2026-10-30T10:00:00"), kwh=8),
                         observed_at_ms=int(now * 1000) + 1)

    async def reopen():
        restored = index(store, clock=lambda: now + 10)
        await restored.async_load()
        return restored

    restored = run(reopen())
    assert restored.dataset_epoch == epoch
    assert restored.change_seq > seq
    assert restored.rows["same"]["row_revision"] == 2
    restored.upsert_session(session("same", stamp("2026-10-30T10:00:00"), kwh=9),
                            observed_at_ms=int(now * 1000) + 11)
    assert restored.rows["same"]["row_revision"] == 3


def test_real_charge_recorder_publishes_recording_completed_price_and_tariff_changes():
    now = stamp("2026-10-14T23:00:00")
    store = MemoryStore()
    idx = index(clock=lambda: now)
    recorder = ChargeRecorder(
        None, "TEST", 70, store=store, timezone="Asia/Hong_Kong")
    recorder.history_index = idx

    def frame(at, charging=1):
        return CarState(
            collect_time=int(at * 1000),
            signals={"soc": 40, "charge_connection": charging, "gear": 0,
                     "speed": 0, "charging_voltage": 600, "charging_current": -10},
        )

    recorder.process(frame(now), now=now)
    record_id = recorder.active["id"]
    assert idx.rows[record_id]["phase"] == "recording"
    recorder.process(frame(now + 60), now=now + 60)
    recorder.process(frame(now + 120, charging=0), now=now + 120)
    completed = idx.rows[record_id]
    assert completed["phase"] == "completed"
    assert completed["energy"]["kwh"] == 0.1
    recording_revision = completed["row_revision"]

    run(recorder.set_session_price(record_id, "total", 5))
    priced = idx.rows[record_id]
    assert priced["row_revision"] > recording_revision
    assert priced["money"] == {
        "amount": 5, "currency": "CNY",
        "basis": "manual_total_estimate", "evidence": "estimated",
    }
    run(recorder.set_session_price(record_id, "auto"))
    run(recorder.set_tariff({"peak_price": 2, "valley_price": 2, "efficiency": 1}))
    auto = idx.rows[record_id]
    assert auto["money"]["basis"] == "ha_current_tariff_estimate"
    assert auto["money"]["amount"] == pytest.approx(.2)
