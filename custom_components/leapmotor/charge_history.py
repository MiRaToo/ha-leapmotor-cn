"""Persistent, snapshot-stable charge history index for the App data contract."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
import time
import uuid
from copy import deepcopy
from typing import Any

CHARGE_HISTORY_CONTRACT_VERSION = 1
CHARGE_HISTORY_STORE_KEY = "charge_history_v1"
CHARGE_HISTORY_STORE_VERSION = 1
CHARGE_HISTORY_SNAPSHOT_TTL_SECONDS = 300
MAX_SAFE_INTEGER = 9_007_199_254_740_991


def _finite(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def _epoch_ms(value: Any) -> int | None:
    number = _finite(value)
    if number is None or number < 0:
        return None
    milliseconds = int(round(number * 1000))
    return milliseconds if 0 <= milliseconds <= MAX_SAFE_INTEGER else None


def _dump(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


class ChargeHistoryIndex:
    """Current row index plus bounded in-memory immutable query snapshots."""

    def __init__(self, hass: Any, vin: str, store: Any = None,
                 *, now: Any = None) -> None:
        self.vin = str(vin or "").strip().upper()
        self._now = now or time.time
        if store is not None:
            self._store = store
        else:
            from homeassistant.helpers.storage import Store
            self._store = Store(
                hass, CHARGE_HISTORY_STORE_VERSION,
                f"leapmotor_{self.vin}_{CHARGE_HISTORY_STORE_KEY}",
            )
        self.dataset_epoch = str(uuid.uuid4())
        self.change_seq = 0
        self.initialized = False
        self.known_complete_from_ms: int | None = None
        self.rows: dict[str, dict] = {}
        self.revision_high_water: dict[str, int] = {}
        self.tombstones: dict[str, dict] = {}
        self._token_secret = uuid.uuid4().hex
        self._snapshots: dict[str, dict] = {}

    async def async_load(self) -> None:
        data = await self._store.async_load() or {}
        if not isinstance(data, dict):
            raise ValueError("charge_history_corrupt")
        if not data:
            return
        if data.get("contract_version") != CHARGE_HISTORY_CONTRACT_VERSION:
            raise ValueError("charge_history_contract_unsupported")
        epoch = data.get("dataset_epoch")
        change_seq = data.get("change_seq")
        known_from = data.get("known_complete_from_ms")
        if (not isinstance(epoch, str) or not epoch
                or not isinstance(change_seq, int) or isinstance(change_seq, bool) or change_seq < 0
                or (known_from is not None
                    and (not isinstance(known_from, int) or isinstance(known_from, bool)
                         or known_from < 0 or known_from > MAX_SAFE_INTEGER))):
            raise ValueError("charge_history_corrupt")
        rows = data.get("rows")
        revisions = data.get("revision_high_water")
        tombstones = data.get("tombstones", {})
        secret = data.get("token_secret")
        if (not isinstance(rows, dict) or not isinstance(revisions, dict)
                or not isinstance(tombstones, dict) or not isinstance(secret, str)
                or len(secret) < 32):
            raise ValueError("charge_history_corrupt")
        validated: dict[str, dict] = {}
        high: dict[str, int] = {}
        for record_id, row in rows.items():
            if not self._valid_row(record_id, row):
                raise ValueError("charge_history_corrupt")
            revision = row["row_revision"]
            prior = revisions.get(record_id)
            if (not isinstance(prior, int) or isinstance(prior, bool)
                    or prior < revision):
                raise ValueError("charge_history_corrupt")
            validated[record_id] = row
            high[record_id] = prior
        for record_id, prior in revisions.items():
            if (not isinstance(record_id, str) or not record_id
                    or not isinstance(prior, int) or isinstance(prior, bool) or prior < 0):
                raise ValueError("charge_history_corrupt")
            high.setdefault(record_id, prior)
        for record_id, tombstone in tombstones.items():
            if (not isinstance(record_id, str) or not record_id
                    or not isinstance(tombstone, dict)
                    or tombstone.get("record_id") != record_id
                    or not isinstance(tombstone.get("row_revision"), int)
                    or isinstance(tombstone.get("row_revision"), bool)
                    or tombstone["row_revision"] < 1
                    or not isinstance(tombstone.get("change_seq"), int)
                    or isinstance(tombstone.get("change_seq"), bool)
                    or tombstone["change_seq"] < 1
                    or not isinstance(tombstone.get("deleted_at_ms"), int)
                    or isinstance(tombstone.get("deleted_at_ms"), bool)
                    or tombstone["deleted_at_ms"] < 0):
                raise ValueError("charge_history_corrupt")
        self.dataset_epoch = epoch
        self.change_seq = change_seq
        self.initialized = data.get("initialized") is True
        self.known_complete_from_ms = known_from
        self.rows = validated
        self.revision_high_water = high
        self.tombstones = deepcopy(tombstones)
        self._token_secret = secret

    def _valid_row(self, record_id: str, row: Any) -> bool:
        if not isinstance(record_id, str) or not record_id or not isinstance(row, dict):
            return False
        if (row.get("record_id") != record_id
                or row.get("row_revision") is None
                or not isinstance(row.get("row_revision"), int)
                or isinstance(row.get("row_revision"), bool)
                or row["row_revision"] < 1
                or not isinstance(row.get("change_seq"), int)
                or isinstance(row.get("change_seq"), bool)
                or row["change_seq"] < 1
                or row.get("phase") not in ("recording", "completed", "partial")
                or not isinstance(row.get("started_at_ms"), int)
                or row["started_at_ms"] < 0
                or not isinstance(row.get("ended_at_ms"), int)
                or row["ended_at_ms"] < row["started_at_ms"]
                or not isinstance(row.get("energy"), dict)
                or not isinstance(row.get("grid_energy"), dict)
                or not isinstance(row.get("money"), dict)):
            return False
        return True

    def _save(self) -> None:
        self._store.async_delay_save(
            lambda: {
                "contract_version": CHARGE_HISTORY_CONTRACT_VERSION,
                "dataset_epoch": self.dataset_epoch,
                "change_seq": self.change_seq,
                "initialized": self.initialized,
                "known_complete_from_ms": self.known_complete_from_ms,
                "rows": deepcopy(self.rows),
                "revision_high_water": dict(self.revision_high_water),
                "tombstones": deepcopy(self.tombstones),
                "token_secret": self._token_secret,
            },
            5,
        )

    def _row_from_session(self, session: dict, observed_at_ms: int) -> dict | None:
        record_id = session.get("id")
        started = _epoch_ms(session.get("started_at"))
        ended = _epoch_ms(session.get("ended_at") or session.get("last_at"))
        if (not isinstance(record_id, str) or not record_id
                or started is None or ended is None or ended < started):
            return None
        active = session.get("active") is True or session.get("ended_at") is None
        partial = bool(active or session.get("partial") is True)
        phase = "recording" if active else "partial" if partial else "completed"
        kwh = _finite(session.get("kwh"))
        if kwh is None or kwh < 0:
            kwh = None
        sources = session.get("sources")
        sources = ([source for source in sources if source in ("power", "soc", "mixed")]
                   if isinstance(sources, list) else [])
        if not sources:
            kwh = None
        energy_coverage = "partial" if kwh is not None and partial else (
            "complete" if kwh is not None else "unavailable")
        grid = _finite(session.get("grid_kwh"))
        if grid is None or grid < 0:
            grid = None
        cost = _finite(session.get("cost"))
        if cost is None or cost < 0:
            cost = None
        override = session.get("price_override") if isinstance(session.get("price_override"), dict) else None
        money_basis = (
            "manual_total_estimate" if override and override.get("mode") == "total"
            else "manual_unit_estimate" if override and override.get("mode") == "unit"
            else "ha_current_tariff_estimate" if cost is not None else "unknown"
        )
        charge_type = session.get("charge_type")
        if charge_type not in ("ac", "dc", "mixed", "unknown"):
            charge_type = "unknown"
        row = {
            "record_id": record_id,
            "row_revision": 0,
            "change_seq": 0,
            "phase": phase,
            "time_basis": "observed",
            "started_at_ms": started,
            "ended_at_ms": ended,
            "charge_type": charge_type,
            "energy": {
                "kwh": kwh,
                "basis": "battery_vehicle_estimate",
                "evidence": "estimated" if kwh is not None else "unknown",
                "coverage": energy_coverage,
                "sources": sources,
            },
            "grid_energy": {
                "kwh": grid,
                "basis": "efficiency_estimate" if grid is not None else "unknown",
                "evidence": "estimated" if grid is not None else "unknown",
            },
            "money": {
                "amount": cost,
                "currency": "CNY" if cost is not None else None,
                "basis": money_basis,
                "evidence": "estimated" if cost is not None else "unknown",
            },
            "peak_kw": _finite(session.get("peak_kw")),
            "average_kw": _finite(session.get("average_kw")),
            "soc_start": _finite(session.get("soc_start")),
            "soc_end": _finite(session.get("soc_end")),
            "observed_at_ms": observed_at_ms,
        }
        for key in ("peak_kw", "average_kw"):
            if row[key] is not None and row[key] < 0:
                row[key] = None
        for key in ("soc_start", "soc_end"):
            if row[key] is not None and not 0 <= row[key] <= 100:
                row[key] = None
        return row

    def upsert_session(self, session: dict, *, observed_at_ms: int | None = None) -> bool:
        observed = int(observed_at_ms if observed_at_ms is not None else self._now() * 1000)
        candidate = self._row_from_session(session, observed)
        if candidate is None:
            return False
        record_id = candidate["record_id"]
        previous = self.rows.get(record_id)
        if previous:
            comparable_previous = {k: v for k, v in previous.items()
                                   if k not in ("row_revision", "change_seq", "observed_at_ms")}
            comparable_candidate = {k: v for k, v in candidate.items()
                                    if k not in ("row_revision", "change_seq", "observed_at_ms")}
            if _dump(comparable_previous) == _dump(comparable_candidate):
                return False
            candidate["row_revision"] = previous["row_revision"] + 1
        else:
            candidate["row_revision"] = self.revision_high_water.get(record_id, 0) + 1
        self.change_seq += 1
        candidate["change_seq"] = self.change_seq
        self.rows[record_id] = candidate
        self.revision_high_water[record_id] = candidate["row_revision"]
        self.tombstones.pop(record_id, None)
        self._save()
        return True

    def reconcile_sessions(
        self,
        sessions: list[dict],
        *,
        observed_at_ms: int | None = None,
        start_complete_window_if_new: bool = True,
    ) -> int:
        observed = int(observed_at_ms if observed_at_ms is not None else self._now() * 1000)
        first_bootstrap = not self.initialized
        changed = 0
        for session in sessions:
            changed += int(self.upsert_session(session, observed_at_ms=observed))
        if first_bootstrap:
            self.initialized = True
            if start_complete_window_if_new:
                self.known_complete_from_ms = observed
            self._save()
        return changed

    def delete(self, record_id: str, *, observed_at_ms: int | None = None) -> bool:
        if not isinstance(record_id, str) or not record_id:
            raise ValueError("invalid_format")
        if record_id not in self.rows:
            return False
        observed = int(observed_at_ms if observed_at_ms is not None else self._now() * 1000)
        self.change_seq += 1
        revision = max(
            self.revision_high_water.get(record_id, 0),
            self.rows[record_id]["row_revision"],
        ) + 1
        self.revision_high_water[record_id] = revision
        self.tombstones[record_id] = {
            "record_id": record_id,
            "row_revision": revision,
            "change_seq": self.change_seq,
            "deleted_at_ms": observed,
        }
        self.rows.pop(record_id, None)
        self._save()
        return True

    def retention(self) -> dict:
        oldest = min((row["started_at_ms"] for row in self.rows.values()), default=None)
        return {
            "mode": "unbounded_after_index_start",
            "oldest_retained_start_ms": oldest,
            "legacy_backfill_coverage": "partial",
            "truncated_before_ms": None,
            "reason": "pre_index_400_cap_records_are_unrecoverable",
        }

    def _scope_key(self, scope_key: str) -> str:
        return f"{CHARGE_HISTORY_CONTRACT_VERSION}\0{scope_key}"

    def _token(self, scope_key: str, snapshot_id: str, offset: int) -> str:
        payload = _dump({"s": snapshot_id, "o": offset}).encode()
        signature = hmac.new(
            self._token_secret.encode(),
            self._scope_key(scope_key).encode() + b"\0" + payload,
            hashlib.sha256,
        ).hexdigest()
        return base64.urlsafe_b64encode(payload).decode().rstrip("=") + "." + signature

    def _read_token(self, scope_key: str, token: str) -> tuple[str, int]:
        try:
            encoded, signature = token.split(".", 1)
            payload = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
            expected = hmac.new(
                self._token_secret.encode(),
                self._scope_key(scope_key).encode() + b"\0" + payload,
                hashlib.sha256,
            ).hexdigest()
            if not hmac.compare_digest(signature, expected):
                raise ValueError
            decoded = json.loads(payload)
            snapshot_id, offset = decoded.get("s"), decoded.get("o")
            if (not isinstance(snapshot_id, str) or not snapshot_id
                    or not isinstance(offset, int) or isinstance(offset, bool) or offset < 0):
                raise ValueError
            return snapshot_id, offset
        except (ValueError, TypeError, KeyError, json.JSONDecodeError) as err:
            raise ValueError("invalid_cursor") from err

    def query(
        self,
        scope_key: str,
        from_ms: int,
        to_ms: int,
        *,
        limit: int = 100,
        page_token: str | None = None,
    ) -> dict:
        now = int(self._now() * 1000)
        for snapshot_id, snapshot in list(self._snapshots.items()):
            if snapshot["expires_at_ms"] < now:
                self._snapshots.pop(snapshot_id, None)
        if page_token:
            snapshot_id, offset = self._read_token(scope_key, page_token)
            snapshot = self._snapshots.get(snapshot_id)
            if snapshot is None or snapshot["expires_at_ms"] < now:
                raise ValueError("snapshot_expired")
            if snapshot["scope_key"] != scope_key:
                raise ValueError("invalid_cursor")
            from_ms = snapshot["requested_from_ms"]
            to_ms = snapshot["requested_to_ms"]
        else:
            for value in (from_ms, to_ms):
                if (not isinstance(value, int) or isinstance(value, bool)
                        or value < 0 or value > MAX_SAFE_INTEGER):
                    raise ValueError("invalid_format")
            if to_ms < from_ms:
                raise ValueError("invalid_format")
            selected = [
                deepcopy(row) for row in self.rows.values()
                if row["started_at_ms"] <= to_ms and row["ended_at_ms"] >= from_ms
            ]
            selected.sort(key=lambda row: (-row["started_at_ms"], row["record_id"]))
            snapshot_id = str(uuid.uuid4())
            known = self.known_complete_from_ms
            coverage = (
                "complete" if known is not None and from_ms >= known
                else "partial" if selected or known is not None
                else "unavailable"
            )
            snapshot = {
                "scope_key": scope_key,
                "rows": selected,
                "requested_from_ms": from_ms,
                "requested_to_ms": to_ms,
                "generation": self.change_seq,
                "dataset_epoch": self.dataset_epoch,
                "known_complete_from_ms": self.known_complete_from_ms,
                "coverage": coverage,
                "coverage_reason": (
                    "range_after_index_start" if coverage == "complete"
                    else "range_may_predate_index_start" if known is not None
                    else "index_not_initialized"
                ),
                "retention": self.retention(),
                "expires_at_ms": now + CHARGE_HISTORY_SNAPSHOT_TTL_SECONDS * 1000,
            }
            self._snapshots[snapshot_id] = snapshot
            while len(self._snapshots) > 32:
                self._snapshots.pop(next(iter(self._snapshots)))
            offset = 0
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 200:
            raise ValueError("invalid_format")
        page = snapshot["rows"][offset:offset + limit]
        next_offset = offset + len(page)
        has_more = next_offset < len(snapshot["rows"])
        return {
            "contract_version": CHARGE_HISTORY_CONTRACT_VERSION,
            "dataset_epoch": snapshot["dataset_epoch"],
            "generation": snapshot["generation"],
            "known_complete_from_ms": snapshot["known_complete_from_ms"],
            "snapshot_id": snapshot_id,
            "requested_range": {
                "from_ms": from_ms,
                "to_ms": to_ms,
            },
            "coverage": snapshot["coverage"],
            "coverage_reason": snapshot["coverage_reason"],
            "retention": snapshot["retention"],
            "record_count": len(snapshot["rows"]),
            "rows": page,
            "has_more": has_more,
            "next_page_token": self._token(scope_key, snapshot_id, next_offset) if has_more else None,
        }
