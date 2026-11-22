# App daily-energy v1 contract

Status: implemented and offline-verified. The command remains
`leapmotor/energy/daily`; raw sync stays on protocol version 1.

## Capability

`leapmotor/sync/v1/info` advertises the feature only when every loaded coordinator has
an initialized v1 cache, trip recorder, ready archive identity, and HA has a valid IANA
time zone:

```json
{
  "capabilities": {
    "daily_energy": {
      "contract_version": 1,
      "command": "leapmotor/energy/daily",
      "time_zone": "Asia/Hong_Kong"
    }
  }
}
```

Fixed offsets such as `+08:00`, an unready archive, and a partially initialized
coordinator do not advertise this capability.

## Identity and calendar

The request remains:

```json
{"type":"leapmotor/energy/daily","days":7,"vin":"LP...","entry_id":"..."}
```

For v1 responses, the handler reads `sync/v1/info` and the complete
`sync/v1/vehicles` list. It normalizes VINs with trim plus uppercase and requires exactly
one match, no duplicate normalized VIN anywhere in the list, the coordinator's
`vehicle_id`, and the coordinator's config-entry `entry_id`. A failure returns an error;
it never falls back to the legacy daily response or starts an implicit cloud request.

Each returned row uses an HA-configured IANA local day:

- historical day: local midnight through the next local midnight minus one second;
- today: local midnight through the frozen response `generated_at`;
- DST 23/25-hour days, month/year boundaries, and configured-zone changes are computed
  from local midnights rather than fixed 86,400-second arithmetic.

`generated_at`, `start_ts`, and `end_ts` are nonnegative integer Unix seconds. The final
today window is recomputed after network waits so a request that crosses local midnight
cannot publish stale day bounds.

## Source and status

Every row contains `km`, `km_src`, `km_status`, `kwh`, `kwh_src`, `kwh_status`, `drv`,
`ac`, and `oth`.

- `official`: cloud daily mileage, or the complete getEC
  `driverEC + acEC + otherEC` measurement.
- `trip`: the local trip recorder estimate.
- `ready`: a trusted current value.
- `stale`: a previously valid value retained after its refresh cooldown failed.
- `pending`: no value yet and work/coverage remains open.
- `unavailable`: no trusted value and no current work is implied.

`pending` and `unavailable` rows have null value/source. Unknown never becomes zero.
Real official three-component zero remains a ready official zero. Trip values never
become official. Official components appear only with official kWh, and response kWh is
the exact sum of the three components supplied to the JSON client.

## Cache and request control

The v1 cache uses a new namespace and Store format version:

```text
leapmotor_<NORMALIZED_VIN>_daily_energy_v1
```

Old `leapmotor_<VIN>_energy_days` rows are not read or migrated. Each v1 record proves
VIN, day, IANA zone, start, end, three components, total, and observation time.
Historical rows require exact bounds. Today rows may be reused with a newer
`generated_at` for 30 minutes, then become stale or are refreshed.

WS and coordinator polling share one lock per normalized VIN. Cache planning, network
fetch, and write occur inside that lock, so concurrent callers cannot duplicate the same
VIN/day/bounds getEC request. Failures and rate limits receive independent cooldowns.

## Compatibility

The v1 response retains the legacy `vin`, `entry_id`, `source`, `pending`,
`coverage_from`, `summary`, `reev`, fuel fields, and per-day extension fields. It adds:

```json
{
  "daily_energy_version": 1,
  "source_id": "archive-source",
  "dataset_id": "archive-dataset",
  "vehicle_id": "archive-vehicle",
  "vin": "LP...",
  "time_zone": "Asia/Hong_Kong",
  "generated_at": 1785376800
}
```

Raw sync protocol remains 1. Old clients without daily capability may continue using
the legacy daily body; strict v1 clients request only 7 or 30 days and reject a payload
whose identity, zone, bounds, row count, sources, or statuses do not match this contract.
