# App data sync membership contract v1

Status: additive capability implemented by `leapmotor/sync/v2/membership`. Existing
`leapmotor/sync/v1/*` behavior remains unchanged.

## Capability

`leapmotor/sync/v1/info` advertises:

```json
{
  "membership_contract_version": 1,
  "capabilities": {
    "membership_v1": 1,
    "stable_membership_revisions": true,
    "membership_coverage": true,
    "membership_count": true
  }
}
```

The capability is informative and does not alter v1 bootstrap/pull payloads. Clients
must still request membership pages explicitly.

## Revision model

Each `(vehicle_id, kind, record_id)` has monotonically increasing
`membership_revision` values. Every revision has an immutable UUID `snapshot_id` and
an immutable ordered set of observation IDs.

A revision changes only when membership changes:

- associating a previously unlinked observation;
- explicitly replacing the complete member set;
- deleting an observation that is currently linked to the record.

Record phase/boundary changes do not advance membership revision. Record JSON contains
`membership_revision`, `membership_coverage`, and `observation_count`, alongside the
existing record revision.

Existing records and links are backfilled conservatively:

- non-empty pre-contract membership is `partial`, never promoted to `complete`;
- no known members is `unavailable`, not a fabricated complete-empty set;
- only `replace_record_membership(..., coverage="complete")` creates `complete`,
  including a proven empty set.

## WebSocket command

```text
leapmotor/sync/v2/membership
```

Request:

```json
{
  "type": "leapmotor/sync/v2/membership",
  "vehicle_id": "uuid",
  "kind": "trip",
  "record_id": "record-id",
  "membership_revision": 12,
  "page_token": null,
  "limit": 100
}
```

`membership_revision` and `page_token` are optional. Omit both on the first request to
use the current revision. A page token always continues the revision embedded in the
token, even when a newer revision has been created.

Response:

```json
{
  "protocol_version": 2,
  "source_id": "ha-source-uuid",
  "dataset_id": "dataset-uuid",
  "vehicle_id": "vehicle-uuid",
  "record_id": "record-id",
  "kind": "trip",
  "membership_revision": 12,
  "coverage": "complete",
  "observation_count": 205,
  "snapshot_id": "immutable-snapshot-uuid",
  "observation_ids": ["..."],
  "next_page_token": "opaque-or-null",
  "has_more": true
}
```

The token is signed and bound to source, dataset, vehicle, kind, record, revision,
snapshot ID, and offset. Cross-scope, mismatched, tampered, or replaced snapshot tokens
are rejected. Membership revisions are retained with the archive; they do not expire
with the 30-minute bootstrap snapshot.

## Coverage meanings

- `complete`: the producer knows the full member set for this revision.
- `partial`: known members are exact, but completeness is unproven.
- `unavailable`: no trustworthy member set is available; count zero does not prove an
  empty record.

Client must not substitute a time-window query for an unavailable/partial membership
set when displaying exact record members.

## Atomicity

Membership revision rows, immutable member items, current `record_observations`, record
metadata, and corresponding `record.upsert` journal events are committed in one SQLite
transaction. A failed replacement leaves both the prior membership revision and current
links intact.
