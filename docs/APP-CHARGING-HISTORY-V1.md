# App charging history v1

Status: additive and offline-verified. Existing `leapmotor/charging/history`
remains unchanged.

## Capability and command

`leapmotor/sync/v1/info` advertises:

```json
{
  "capabilities": {
    "charging_history": {
      "contract_version": 1,
      "command": "leapmotor/charging/records/v1"
    }
  }
}
```

The capability appears only when every loaded coordinator has a persistent charge
index, matching normalized VIN, ready archive identity, and an initialized
`vehicle_id`.

Request:

```json
{
  "type": "leapmotor/charging/records/v1",
  "entry_id": "entry-id",
  "vin": "NORMALIZED-VIN",
  "from_ms": 1764547200000,
  "to_ms": 1796083200000,
  "limit": 100,
  "page_token": null
}
```

The command requires an HA administrator, like the raw archive commands. It verifies the
complete `sync/v1/vehicles` list, normalized VIN uniqueness, archive `vehicle_id`, and
coordinator config-entry identity before reading the index.

## Persistent index

The index uses a new Store namespace:

```text
leapmotor_<NORMALIZED_VIN>_charge_history_v1
```

It does not migrate the old 400-session charge Store. Existing retained charging
sessions are backfilled into the new index conservatively, but their older already-pruned
rows are unrecoverable and are not claimed.

The Store persists:

- a stable dataset epoch UUID;
- a monotonic `change_seq`;
- `known_complete_from_ms` for the range observed after index initialization;
- immutable-row-version counters and current logical charge rows;
- deletion tombstones and a token signing secret.

New session completion, price overrides, and tariff-driven re-estimation update the
index. A restart closes the old active session through the existing recorder lifecycle,
then reconciles the completed result into the index. Missing sessions are not bulk
deleted because the old recorder's 400-row cap cannot distinguish pruning from deletion.

## Query snapshot and coverage

The first query freezes an immutable in-memory snapshot for five minutes. Subsequent
pages use a signed opaque token bound to source, dataset, vehicle, snapshot, and offset.
Concurrent revisions do not alter an open snapshot. Expired, tampered, cross-scope, or
replaced tokens return `snapshot_expired` or `invalid_cursor`.

Response:

```json
{
  "protocol_version": 1,
  "contract_version": 1,
  "source_id": "source-id",
  "dataset_id": "dataset-id",
  "vehicle_id": "vehicle-id",
  "vin": "NORMALIZED-VIN",
  "entry_id": "entry-id",
  "timezone": "Asia/Hong_Kong",
  "dataset_epoch": "uuid",
  "generation": 42,
  "known_complete_from_ms": 1796083200000,
  "snapshot_id": "uuid",
  "requested_range": {"from_ms": 0, "to_ms": 1796083200000},
  "coverage": "partial",
  "coverage_reason": "range_may_predate_index_start",
  "retention": {
    "mode": "unbounded_after_index_start",
    "oldest_retained_start_ms": 1764547200000,
    "legacy_backfill_coverage": "partial",
    "truncated_before_ms": null,
    "reason": "pre_index_400_cap_records_are_unrecoverable"
  },
  "record_count": 205,
  "rows": [],
  "has_more": true,
  "next_page_token": "opaque-or-null"
}
```

Coverage meanings:

- `complete`: the index directly observed the whole requested range after
  `known_complete_from_ms`; this proves index completeness, not physical metering.
- `partial`: the request may predate index initialization or includes legacy backfill.
- `unavailable`: the index has not established a complete range yet.

The 31-day legacy history window is never treated as full history. Since the previous
400-session cap already discarded older rows, `truncated_before_ms` remains null until
an evidenced boundary exists. An empty response does not prove that the vehicle never
charged.

## Row contract

Each row contains `record_id`, `row_revision`, `change_seq`, `phase`, observed start/end
milliseconds, charge type, SOC endpoints, peak/average power, energy, grid energy, and
money.

- Energy uses `basis=battery_vehicle_estimate` and `evidence=estimated` only when the
  HA recorder has an explicit power/SOC source. A known zero with a source stays zero;
  missing source/value remains null.
- `phase=recording` or a partial recorder result has `energy.coverage=partial`, even
  when a known subtotal exists.
- Grid energy uses `basis=efficiency_estimate`; it is not a meter reading.
- Money currency is `CNY`. Basis distinguishes `ha_current_tariff_estimate`,
  `manual_unit_estimate`, and `manual_total_estimate`. Amounts are estimates, not
  verified payments.
- `time_basis=observed` means the first and last recorder observations. It does not
  claim physical plug-in or unplug time.

Raw observations, SQLite rows, power sample arrays, and SOC sample arrays are not copied
into this API. A business row never increases raw sample completeness or membership
coverage.

## Deletion and retention

Explicit deletion advances the row high-water mark, appends a tombstone with its own
`change_seq`, removes the current row, and preserves the dataset epoch. The index never
reuses the same `record_id` revision. A restarted client should replace its retained
range only after receiving a complete snapshot or should reconcile absence against
`dataset_epoch`, `generation`, `coverage`, and retention.

No automatic pruning is performed by this index after its creation. Legacy records
already removed by the old 400-session cap cannot be recovered.

## Compatibility

The existing `leapmotor/charging/history` command, its 1–31 day body, tariff controls,
price overrides, active state, and current charge card behavior remain available. The
new command is a parallel business index and does not alter raw sync protocol version 1.
