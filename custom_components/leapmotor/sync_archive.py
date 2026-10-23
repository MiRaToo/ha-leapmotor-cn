"""Independent, serialized SQLite archive for raw vehicle observations and sync history."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import sqlite3
import math
import time
import uuid
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

PROTOCOL_VERSION = 1
FIELD_SCHEMA = "leapmotor.raw.v1"
_FIELD_NAMES = {"2":"longitude","3":"latitude","3724":"longitude_backup_1","3725":"latitude_backup_1","2191":"longitude_backup_2","2190":"latitude_backup_2",
           "100003":"soc_precise","1204":"soc","1318":"odometer","1319":"speed","1010":"gear","1944":"vehicle_state","1258":"ready",
           "1149":"charge_connection","1197":"dc_cable_connected","47":"charge_plug","1177":"charging_voltage","1178":"charging_current","bcmKeyPositionOn3":"ready",
           "sts":"signal_time","collectTime":"collect_time","collectTimeMs":"collect_time_ms","signalMap.sts":"signal_time",
           "longitude":"longitude","latitude":"latitude","soc":"soc","totalMileage":"odometer","speed":"speed","gearStatus":"gear",
           "batteryVoltage":"charging_voltage","batteryCurrent":"charging_current","chargeState":"charge_state","vehicleState":"vehicle_state","plugStatus":"charge_plug","dcInputFastCharge":"dc_charge"}
_FIELDS = {key:{"name":name,"unit":("degrees" if "longitude" in name or "latitude" in name else "%" if name.startswith("soc") else "km" if name=="odometer" else "km/h" if name=="speed" else "V" if name=="charging_voltage" else "A" if name=="charging_current" else "ms" if key.startswith("collectTime") else "unknown"),"notes":"Raw value as provided; no unit conversion." if key not in ("2","3","3724","3725","2191","2190","100003","1204","1318","1319","1177","1178","collectTime","collectTimeMs") else ("Vehicle supplied timestamp; original key and value retained." if key in ("sts","collectTime","collectTimeMs","signalMap.sts") else "Raw signal identifier; enum values retained without normalization.")} for key,name in _FIELD_NAMES.items()}
_FIELDS["1149"]["known_values"] = {"0":"not_connected", "1":"charging", "2":"connected_standby", "3":"connected", "4":"connected", "5":"not_connected"}
_FIELDS["1149"]["notes"] = "Observed mapping; model differences and contradictory driving frames are possible. Preserve original value."
_FIELDS["chargeState"]["notes"] = "Named T03 state; do not assume every model shares the same enum."
_TIME_FIELDS = {f"{prefix}{key}": {"name":"provider_time", "unit":"ms" if key in ("collectTime", "collectTimeMs") else "unknown"}
                for prefix in ("", "signalMap.", "data.", "source.") for key in ("collectTime", "collectTimeMs", "sts")}
_LEGACY_FIELDS = {"legacy_latitude_wgs84":{"name":"latitude", "unit":"degrees"},
                  "legacy_longitude_wgs84":{"name":"longitude", "unit":"degrees"},
                  "legacy_speed_kmh":{"name":"speed", "unit":"km/h"},
                  "legacy_soc_percent":{"name":"soc", "unit":"%"}}

def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)

def _has_reliable_timestamp(values):
    for value in (values or {}).values():
        if isinstance(value,bool) or value is None: continue
        try:
            number = float(value)
            if math.isfinite(number) and number > 0: return True
        except (ValueError,TypeError,OverflowError):
            if isinstance(value,str):
                try:
                    datetime.fromisoformat(value.replace("Z","+00:00")); return True
                except ValueError: pass
    return False

class SyncArchive:
    """One dedicated worker and connection; methods are sync and should run on its executor."""
    def __init__(self, path: str | Path):
        self.path = str(path)
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="leapmotor-archive")
        self._conn: sqlite3.Connection | None = None
        self.ready = False
        self.error = ""

    def run(self, method: str, *args):
        return self._executor.submit(getattr(self, method), *args).result()

    def open(self) -> None:
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        c = sqlite3.connect(self.path, timeout=10)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA foreign_keys=ON")
        c.execute("PRAGMA journal_mode=WAL")
        c.executescript("""
        CREATE TABLE IF NOT EXISTS metadata(k TEXT PRIMARY KEY,v TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS vehicles(vehicle_id TEXT PRIMARY KEY,vin TEXT UNIQUE NOT NULL,display_name TEXT NOT NULL DEFAULT '',entry_id TEXT NOT NULL DEFAULT '',device_id TEXT NOT NULL DEFAULT '');
        CREATE TABLE IF NOT EXISTS observations(observation_id TEXT PRIMARY KEY,vehicle_id TEXT NOT NULL REFERENCES vehicles(vehicle_id),origin TEXT NOT NULL,fidelity TEXT NOT NULL,field_schema TEXT NOT NULL,layout TEXT NOT NULL,coordinate_system TEXT NOT NULL,received_at_ms INTEGER NOT NULL,source_timestamps TEXT NOT NULL,signals_raw TEXT NOT NULL,legacy_record TEXT,source_key TEXT,deleted INTEGER NOT NULL DEFAULT 0,UNIQUE(vehicle_id,source_key));
        CREATE TABLE IF NOT EXISTS records(vehicle_id TEXT NOT NULL REFERENCES vehicles(vehicle_id),kind TEXT NOT NULL,record_id TEXT NOT NULL,data TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(vehicle_id,kind,record_id));
        CREATE TABLE IF NOT EXISTS record_observations(vehicle_id TEXT NOT NULL,kind TEXT NOT NULL,record_id TEXT NOT NULL,observation_id TEXT NOT NULL,ordinal INTEGER NOT NULL,PRIMARY KEY(vehicle_id,kind,record_id,observation_id));
        CREATE TABLE IF NOT EXISTS capture_events(event_id TEXT PRIMARY KEY,vehicle_id TEXT NOT NULL REFERENCES vehicles(vehicle_id),data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS changes(vehicle_id TEXT NOT NULL,seq INTEGER NOT NULL,commit_id TEXT NOT NULL,op TEXT NOT NULL,entity_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(vehicle_id,seq));
        CREATE TABLE IF NOT EXISTS snapshots(snapshot_id TEXT PRIMARY KEY,vehicle_id TEXT NOT NULL,head_seq INTEGER NOT NULL,expires INTEGER NOT NULL,items TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS snapshot_items(snapshot_id TEXT NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(snapshot_id,ordinal));
        CREATE TABLE IF NOT EXISTS legacy_imports(vehicle_id TEXT NOT NULL,kind TEXT NOT NULL,record_id TEXT NOT NULL,PRIMARY KEY(vehicle_id,kind,record_id));
        CREATE TABLE IF NOT EXISTS migration_status(vehicle_id TEXT PRIMARY KEY,status TEXT NOT NULL,updated_at_ms INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS observations_vehicle_time ON observations(vehicle_id,received_at_ms,observation_id);
        """)
        # Versioned immutable journal payloads let snapshots store small references,
        # rather than duplicate and reparse the entire raw archive on every page.
        if "kind" not in {row[1] for row in c.execute("PRAGMA table_info(changes)")}:
            c.execute("ALTER TABLE changes ADD COLUMN kind TEXT NOT NULL DEFAULT ''")
            for row in c.execute("SELECT vehicle_id,seq,data FROM changes WHERE op LIKE 'record.%'").fetchall():
                c.execute("UPDATE changes SET kind=? WHERE vehicle_id=? AND seq=?",
                          (json.loads(row["data"]).get("kind", ""), row["vehicle_id"], row["seq"]))
        c.execute("DELETE FROM snapshots WHERE items!='[]'")
        for key in ("source_id", "dataset_id", "cursor_secret"):
            if c.execute("SELECT 1 FROM metadata WHERE k=?", (key,)).fetchone() is None:
                c.execute("INSERT INTO metadata VALUES(?,?)", (key, uuid.uuid4().hex if key != "cursor_secret" else os.urandom(32).hex()))
        c.execute("DELETE FROM snapshots WHERE expires < ?",(int(time.time()),))
        c.commit(); self._conn = c; self.ready = True

    def close(self) -> None:
        if self._conn:
            self._conn.close(); self._conn = None
        self.ready = False

    def recover(self):
        """Reopen after an archive I/O failure; emit recovery facts in the new connection."""
        self.close(); self.open(); self.add_recovery_events()

    def add_recovery_events(self):
        c=self._c(); now=int(time.time()*1000)
        with c:
            for row in c.execute("SELECT vehicle_id FROM vehicles").fetchall():
                vid=row[0]; eid=str(uuid.uuid4()); ev={"event":"archive_recovered","occurred_at_ms":now,"origin":"leapmotor_cloud","request_result":"archive reopened after storage error"}
                c.execute("INSERT INTO capture_events VALUES(?,?,?)",(eid,vid,_json(ev))); self._event(vid,"capture_event.append",eid,ev)

    def shutdown(self) -> None:
        """Call after close has run on the worker, from the owning event-loop thread."""
        self._executor.shutdown(wait=True, cancel_futures=False)

    def _c(self):
        if not self.ready or self._conn is None: raise RuntimeError("archive_unavailable")
        return self._conn

    def _meta(self, key): return self._c().execute("SELECT v FROM metadata WHERE k=?",(key,)).fetchone()[0]
    def _require_vehicle(self, vid):
        if not self._c().execute("SELECT 1 FROM vehicles WHERE vehicle_id=?",(vid,)).fetchone():
            raise ValueError("vehicle_unavailable")
    def info(self):
        rows=self._c().execute("SELECT status FROM migration_status").fetchall()
        migration="complete" if rows and all(r[0]=="complete" for r in rows) else "pending_or_partial"
        return {"protocol_version":1,"source_id":self._meta("source_id"),"dataset_id":self._meta("dataset_id"),"ready":self.ready,"commands":["info","vehicles","bootstrap","pull","observations","records"],"field_schema":"leapmotor.raw.v1","fields":_FIELDS,
                "schemas": {FIELD_SCHEMA:{"fields":_FIELDS,"source_timestamps":_TIME_FIELDS}, "leapmotor.legacy.v1":{"fields":_LEGACY_FIELDS,"source_timestamps":{"legacy_ha_sample_time_seconds":{"unit":"s"}}}},
                "raw_full_retention":True,"retention":"unbounded; explicit deletion only","migration":{"status":migration,"fidelity":"legacy_processed/legacy_partial"},"limitations":["administrator_only","no_data_purge_command","legacy files already evicted by HA are unrecoverable","archive I/O failures retry on a later vehicle poll"]}

    def ensure_vehicle(self, vin: str, name="", entry_id="", device_id=""):
        vin=str(vin or "").strip().upper()
        if not vin: raise ValueError("vehicle_unavailable")
        c=self._c(); row=c.execute("SELECT vehicle_id FROM vehicles WHERE vin=?",(vin,)).fetchone()
        if row: c.execute("UPDATE vehicles SET display_name=?,entry_id=?,device_id=? WHERE vin=?",(name,entry_id,device_id,vin)); c.commit(); return row[0]
        vid=str(uuid.uuid4())
        with c:
            c.execute("INSERT INTO vehicles(vehicle_id,vin,display_name,entry_id,device_id) VALUES(?,?,?,?,?)",(vid,vin,name,entry_id,device_id))
            c.execute("INSERT INTO migration_status VALUES(?,?,?)",(vid,"pending",int(time.time()*1000)))
        return vid

    def set_migration_status(self, vid, status):
        self._require_vehicle(vid)
        if status not in ("pending","partial","complete"): raise ValueError("invalid_format")
        self._c().execute("INSERT INTO migration_status VALUES(?,?,?) ON CONFLICT(vehicle_id) DO UPDATE SET status=excluded.status,updated_at_ms=excluded.updated_at_ms",(vid,status,int(time.time()*1000))); self._c().commit()

    def add_stop_events(self, vehicle_ids=()):
        c=self._c(); now=int(time.time()*1000)
        with c:
            for vid in set(vehicle_ids):
                self._require_vehicle(vid)
                eid=str(uuid.uuid4()); ev={"event":"collector_stopped","occurred_at_ms":now,"origin":"leapmotor_cloud","request_result":"HA stopping; exact last sample boundary may be unknown"}
                c.execute("INSERT INTO capture_events VALUES(?,?,?)",(eid,vid,_json(ev))); self._event(vid,"capture_event.append",eid,ev)

    def vehicles(self, configured=()):
        c=self._c(); rows=[]
        for r in c.execute("SELECT * FROM vehicles ORDER BY vin"):
            cfg=next((x for x in configured if str(x.get("vin","")).strip().upper()==r["vin"]),{})
            migration=c.execute("SELECT status FROM migration_status WHERE vehicle_id=?",(r["vehicle_id"],)).fetchone()
            rows.append({"vehicle_id":r["vehicle_id"],"vin":r["vin"],"name":cfg.get("name") or r["display_name"],"entry_id":cfg.get("entry_id") or None,"device_id":cfg.get("device_id") or None,"loaded":bool(cfg.get("loaded")),"archive_ready":self.ready,"migration_status":migration[0] if migration else "pending"})
        return rows

    def _event(self, vid, op, eid, data):
        if op == "capture_event.append":
            data = {**data, "event_id": eid, "vehicle_id": vid}
        c=self._c(); seq=(c.execute("SELECT COALESCE(MAX(seq),0)+1 FROM changes WHERE vehicle_id=?",(vid,)).fetchone()[0]); cid=str(uuid.uuid4())
        c.execute("INSERT INTO changes(vehicle_id,seq,commit_id,op,entity_id,data,kind) VALUES(?,?,?,?,?,?,?)",
                  (vid,seq,cid,op,eid,_json(data),data.get("kind", "") if op.startswith("record.") else "")); return seq

    def put_record(self, vid, kind, record_id, data):
        self._require_vehicle(vid)
        if kind not in ("trip", "charge") or not record_id: raise ValueError("invalid_format")
        # Strictly retain protocol metadata; discard all derived business statistics.
        allowed={k:data[k] for k in ("record_id","kind","phase","revision","boundary_hint","algorithm_version","legacy_source") if k in data}
        allowed.update(record_id=record_id,kind=kind)
        c=self._c()
        with c:
            c.execute("INSERT INTO records VALUES(?,?,?,?,0) ON CONFLICT(vehicle_id,kind,record_id) DO UPDATE SET data=excluded.data,deleted=0",(vid,kind,record_id,_json(allowed)))
            self._event(vid,"record.upsert",record_id,allowed)

    def associate_observation(self, vid, kind, record_id, observation_id, phase, started_at_ms, ended_at_ms=None):
        self._require_vehicle(vid)
        if kind not in ("trip","charge"): raise ValueError("invalid_format")
        c=self._c()
        with c:
            linked = False
            if observation_id:
                if not c.execute("SELECT 1 FROM observations WHERE vehicle_id=? AND observation_id=? AND deleted=0",(vid,observation_id)).fetchone(): raise ValueError("not_found")
                ordinal=c.execute("SELECT COALESCE(MAX(ordinal),-1)+1 FROM record_observations WHERE vehicle_id=? AND kind=? AND record_id=?",(vid,kind,record_id)).fetchone()[0]
                cur=c.execute("INSERT OR IGNORE INTO record_observations VALUES(?,?,?,?,?)",(vid,kind,record_id,observation_id,ordinal))
                linked = bool(cur.rowcount)
            old=c.execute("SELECT data FROM records WHERE vehicle_id=? AND kind=? AND record_id=?",(vid,kind,record_id)).fetchone()
            boundary={"source":"HA grouping hint","started_at_ms":started_at_ms,"ended_at_ms":ended_at_ms}
            if not linked and old:
                previous=json.loads(old[0])
                if previous.get("phase")==phase and previous.get("boundary_hint")==boundary: return False
            rev=(int(json.loads(old[0]).get("revision",0))+1) if old else 1
            data={"record_id":record_id,"kind":kind,"phase":phase,"revision":rev,"algorithm_version":"ha-grouping-v1","legacy_source":json.loads(old[0]).get("legacy_source") if old else None,"boundary_hint":boundary}
            c.execute("INSERT INTO records VALUES(?,?,?,?,0) ON CONFLICT(vehicle_id,kind,record_id) DO UPDATE SET data=excluded.data,deleted=0",(vid,kind,record_id,_json(data)))
            self._event(vid,"record.upsert",record_id,data)
        return True

    def import_legacy(self, vid, kind, record_id, points, meta):
        """Idempotently import actually retained legacy points; never promote derived charge power."""
        self._require_vehicle(vid); c=self._c()
        if kind not in ("trip","charge"): raise ValueError("invalid_format")
        with c:
            if c.execute("SELECT 1 FROM legacy_imports WHERE vehicle_id=? AND kind=? AND record_id=?",(vid,kind,record_id)).fetchone(): return 0
            # Native records already have complete new samples; do not re-import their
            # lossy card representation on every HA restart.
            if c.execute("SELECT 1 FROM records WHERE vehicle_id=? AND kind=? AND record_id=?",(vid,kind,record_id)).fetchone():
                c.execute("INSERT INTO legacy_imports VALUES(?,?,?)",(vid,kind,record_id))
                return 0
            phase="recording" if meta.get("recording") else "partial" if meta.get("partial") or meta.get("track_dropped") else "completed"
            rec={"record_id":record_id,"kind":kind,"phase":phase,"revision":1,"legacy_source":"legacy_ha_trip" if kind=="trip" else "legacy_ha_charge","boundary_hint":{"source":"HA legacy grouping","started_at_ms":int(meta["started_at"]*1000) if meta.get("started_at") else None,"ended_at_ms":int(meta["ended_at"]*1000) if meta.get("ended_at") else None}}
            c.execute("INSERT INTO records VALUES(?,?,?,?,0)",(vid,kind,record_id,_json(rec)))
            self._event(vid,"record.upsert",record_id,rec)
            count=0
            for index,p in enumerate(points or []):
                try:
                    if kind=="trip":
                        lat,lon=p[0],p[1]; signals={"legacy_latitude_wgs84":lat,"legacy_longitude_wgs84":lon}
                        if len(p)>2 and p[2] is not None: signals["legacy_speed_kmh"] = p[2]
                        if len(p)>4 and p[4] is not None: signals["legacy_soc_percent"] = p[4]
                        ts=p[3] if len(p)>3 else None; legacy={"record_id":record_id,"point_index":index,"stored_coordinate_system":"wgs84","coordinate_version":meta.get("coordinate_version")}
                    else:
                        # Old charge store has SOC samples but power_samples are computed values and are excluded.
                        ts=p[0] if len(p)>0 else None; soc=p[1] if len(p)>1 else None
                        signals={"legacy_soc_percent":soc} if soc is not None else {}
                        legacy={"record_id":record_id,"point_index":index,"source_time_semantics":"legacy HA sample time"}
                    oid=str(uuid.uuid4()); received=int(time.time()*1000)
                    timestamps={"legacy_ha_sample_time_seconds":ts} if ts is not None else {}
                    fidelity="legacy_processed" if kind=="trip" else "legacy_partial"
                    payload={"observation_id":oid,"vehicle_id":vid,"origin":"legacy_ha_trip" if kind=="trip" else "legacy_ha_charge","fidelity":fidelity,"field_schema":"leapmotor.legacy.v1","layout":"legacy_points","coordinate_system":"wgs84" if kind=="trip" else "unknown","received_at_ms":received,"source_timestamps":timestamps,"signals_raw":signals,"legacy_record":legacy}
                    c.execute("INSERT INTO observations VALUES(?,?,?,?,?,?,?,?,?,?,?, ?,0)",(oid,vid,payload["origin"],fidelity,payload["field_schema"],"legacy_points",payload["coordinate_system"],received,_json(timestamps),_json(signals),_json(legacy),f"legacy:{kind}:{record_id}:{index}"))
                    c.execute("INSERT INTO record_observations VALUES(?,?,?,?,?)",(vid,kind,record_id,oid,index))
                    self._event(vid,"observation.upsert",oid,payload); count+=1
                except (IndexError,TypeError,ValueError):
                    continue
            c.execute("INSERT INTO legacy_imports VALUES(?,?,?)",(vid,kind,record_id))
        return count

    def delete_entity(self, vid, entity_type, entity_id, kind=None, allow_missing_record=False):
        self._require_vehicle(vid); c=self._c()
        with c:
            if entity_type=="observation":
                row=c.execute("SELECT observation_id FROM observations WHERE vehicle_id=? AND observation_id=? AND deleted=0",(vid,entity_id)).fetchone()
                if not row: raise ValueError("not_found")
                c.execute("UPDATE observations SET deleted=1 WHERE vehicle_id=? AND observation_id=?",(vid,entity_id)); op="observation.delete"
            elif entity_type=="record":
                if kind not in ("trip", "charge"): raise ValueError("invalid_format")
                row=c.execute("SELECT record_id FROM records WHERE vehicle_id=? AND kind=? AND record_id=? AND deleted=0",(vid,kind,entity_id)).fetchone()
                if not row and not allow_missing_record: raise ValueError("not_found")
                if not row:
                    # HA may delete a legacy trip while its background import is pending.
                    # Persist the tombstone first so that importer cannot resurrect it.
                    c.execute("INSERT OR IGNORE INTO records VALUES(?,?,?,?,1)",
                              (vid,kind,entity_id,_json({"record_id":entity_id,"kind":kind})))
                c.execute("UPDATE records SET deleted=1 WHERE vehicle_id=? AND kind=? AND record_id=?",(vid,kind,entity_id)); op="record.delete"
            else: raise ValueError("invalid_format")
            self._event(vid,op,entity_id,{"vehicle_id":vid,"kind":kind} if kind else {"vehicle_id":vid})

    def add_capture_event(self, vid, event):
        self._require_vehicle(vid)
        if event.get("event") not in ("collector_started","collector_stopped","poll_success","poll_failed","vehicle_unavailable","archive_recovered"): raise ValueError("invalid_format")
        eid=str(uuid.uuid4()); c=self._c(); data={k:event[k] for k in ("event","occurred_at_ms","origin","request_result","sampling_interval_seconds","observation_id","status","business_code") if k in event}
        with c:
            c.execute("INSERT INTO capture_events VALUES(?,?,?)",(eid,vid,_json(data)))
            self._event(vid,"capture_event.append",eid,data)
        return eid

    def ingest(self, vid, layout, native, timestamps, received, coordinate="unknown", sampling_interval=None):
        c=self._c(); self._require_vehicle(vid); allowed={str(k):v for k,v in (native or {}).items() if str(k) in _FIELDS}
        key=None
        if _has_reliable_timestamp(timestamps): key=hashlib.sha256(_json([timestamps,layout,coordinate,allowed]).encode()).hexdigest()
        else: key=None
        with c:
            if key:
                old=c.execute("SELECT observation_id FROM observations WHERE vehicle_id=? AND source_key=?",(vid,key)).fetchone()
            else: old=None
            oid=old[0] if old else str(uuid.uuid4())
            payload={"observation_id":oid,"vehicle_id":vid,"origin":"leapmotor_cloud","fidelity":"native_raw","field_schema":FIELD_SCHEMA,"layout":layout,"coordinate_system":coordinate,"received_at_ms":int(received),"source_timestamps":timestamps or {},"signals_raw":allowed,"legacy_record":None}
            if not old:
                c.execute("INSERT INTO observations VALUES(?,?,?,?,?,?,?,?,?,?,?, ?,0)",(oid,vid,"leapmotor_cloud","native_raw",FIELD_SCHEMA,layout,coordinate,int(received),_json(timestamps or {}),_json(allowed),None,key))
                self._event(vid,"observation.upsert",oid,payload)
            ev={"event":"poll_success","occurred_at_ms":int(received),"origin":"leapmotor_cloud","observation_id":oid,"request_result":"success"}
            if sampling_interval is not None:
                ev["sampling_interval_seconds"] = sampling_interval
            eid=str(uuid.uuid4()); c.execute("INSERT INTO capture_events VALUES(?,?,?)",(eid,vid,_json(ev)))
            self._event(vid,"capture_event.append",eid,ev)
        return oid

    def _token(self, body):
        raw=_json(body).encode(); sig=hmac.new(bytes.fromhex(self._meta("cursor_secret")),raw,hashlib.sha256).hexdigest()
        import base64
        return base64.urlsafe_b64encode(raw+b"."+sig.encode()).decode().rstrip("=")
    def _untoken(self, token):
        import base64
        try:
            raw=base64.urlsafe_b64decode(token+"="*(-len(token)%4)); body,sig=raw.rsplit(b".",1)
            want=hmac.new(bytes.fromhex(self._meta("cursor_secret")),body,hashlib.sha256).hexdigest().encode()
            if not hmac.compare_digest(sig,want): raise ValueError
            parsed = json.loads(body)
            if not isinstance(parsed, dict): raise ValueError
            return parsed
        except Exception: raise ValueError("invalid_cursor") from None

    def pull(self, vid, cursor=None, limit=100):
        c=self._c(); self._require_vehicle(vid); head=c.execute("SELECT COALESCE(MAX(seq),0) FROM changes WHERE vehicle_id=?",(vid,)).fetchone()[0]
        if not cursor: raise ValueError("invalid_cursor")
        seq=0
        t=self._untoken(cursor)
        if (t.get("view") != "pull" or type(t.get("seq")) is not int
                or t["seq"] < 0 or not isinstance(t.get("commit_id"), str)):
            raise ValueError("invalid_cursor")
        if t.get("vehicle_id")!=vid: raise ValueError("invalid_cursor")
        if t.get("source_id")!=self._meta("source_id") or t.get("dataset_id")!=self._meta("dataset_id"): raise ValueError("reset_required")
        seq=int(t["seq"]); committed=c.execute("SELECT commit_id FROM changes WHERE vehicle_id=? AND seq=?",(vid,seq)).fetchone()
        if seq and (not committed or committed[0]!=t.get("commit_id")): raise ValueError("reset_required")
        rows=c.execute("SELECT * FROM changes WHERE vehicle_id=? AND seq>? ORDER BY seq LIMIT ?",(vid,seq,min(max(int(limit),1),200))).fetchall()
        changes=[]
        for r in rows:
            item={"seq":r["seq"],"op":r["op"],"entity_id":r["entity_id"],"data":json.loads(r["data"])}
            if changes and len(_json([*changes,item]).encode("utf-8"))>500*1024: break
            if not changes and len(_json(item).encode("utf-8"))>500*1024: raise ValueError("invalid_format")
            changes.append(item)
        end=changes[-1]["seq"] if changes else seq; commit=(c.execute("SELECT commit_id FROM changes WHERE vehicle_id=? AND seq=?",(vid,end)).fetchone() or [""])[0]
        token=self._token({"source_id":self._meta("source_id"),"dataset_id":self._meta("dataset_id"),"vehicle_id":vid,"view":"pull","seq":end,"commit_id":commit})
        return {"changes":changes,"next_cursor":token,"has_more":end<head}

    def bootstrap(self, vid, page_token=None, limit=100):
        c=self._c(); self._require_vehicle(vid); now=int(time.time()); offset=0
        if page_token:
            t=self._untoken(page_token)
            if t.get("vehicle_id")!=vid or t.get("view")!="bootstrap": raise ValueError("invalid_cursor")
            if t.get("source_id")!=self._meta("source_id") or t.get("dataset_id")!=self._meta("dataset_id"): raise ValueError("reset_required")
            snap=c.execute("SELECT * FROM snapshots WHERE snapshot_id=? AND vehicle_id=?",(t["snapshot_id"],vid)).fetchone()
            if not snap or snap["expires"]<now: raise ValueError("snapshot_expired")
            sid=snap["snapshot_id"]; offset=int(t["offset"]); head=snap["head_seq"]
        else:
            with c:
                c.execute("DELETE FROM snapshots WHERE expires < ?",(now,))
                head=c.execute("SELECT COALESCE(MAX(seq),0) FROM changes WHERE vehicle_id=?",(vid,)).fetchone()[0]
                sid=str(uuid.uuid4())
                c.execute("INSERT INTO snapshots VALUES(?,?,?,?,?)",(sid,vid,head,now+1800,"[]"))
                c.execute("""
                    INSERT INTO snapshot_items(snapshot_id,ordinal,seq)
                    SELECT ?, ROW_NUMBER() OVER (ORDER BY seq)-1, seq FROM (
                        SELECT seq,op, ROW_NUMBER() OVER (
                            PARTITION BY CASE
                                WHEN op LIKE 'observation.%' THEN 'observation'
                                WHEN op LIKE 'record.%' THEN 'record'
                                ELSE 'capture_event' END, kind,entity_id
                            ORDER BY seq DESC) AS latest
                        FROM changes WHERE vehicle_id=? AND seq<=?
                    ) WHERE latest=1 AND op IN ('observation.upsert','record.upsert','capture_event.append')
                """,(sid,vid,head))
        lim=min(max(int(limit),1),200)
        rows=c.execute("""
            SELECT ch.* FROM snapshot_items si JOIN changes ch
              ON ch.vehicle_id=? AND ch.seq=si.seq
            WHERE si.snapshot_id=? AND si.ordinal>=? ORDER BY si.ordinal LIMIT ?
        """,(vid,sid,offset,lim+1)).fetchall()
        page=[]; size=0
        for row in rows[:lim]:
            entity_type="observation" if row["op"].startswith("observation.") else "record" if row["op"].startswith("record.") else "capture_event"
            data=json.loads(row["data"])
            if entity_type=="capture_event":
                data={**data,"event_id":row["entity_id"],"vehicle_id":vid}
            item={"entity_type":entity_type,"data":data}
            item_size=len(_json(item).encode("utf-8"))+1
            if item_size>500*1024: raise ValueError("invalid_format")
            if page and size+item_size>500*1024: break
            page.append(item); size+=item_size
        n=offset+len(page); more=len(page)<len(rows)
        return {"items":page,"next_page_token":self._token({"source_id":self._meta("source_id"),"dataset_id":self._meta("dataset_id"),"vehicle_id":vid,"view":"bootstrap","snapshot_id":sid,"offset":n}) if more else None,"has_more":more,"cursor":None if more else self._token({"source_id":self._meta("source_id"),"dataset_id":self._meta("dataset_id"),"vehicle_id":vid,"view":"pull","seq":head,"commit_id":(c.execute("SELECT commit_id FROM changes WHERE vehicle_id=? AND seq=?",(vid,head)).fetchone() or [""])[0]})}

    def observations(self, vid, after=None, limit=100, record_id=None, kind=None):
        self._require_vehicle(vid); offset=0
        scope=hashlib.sha256(_json([record_id,kind]).encode()).hexdigest()
        if after:
            t=self._untoken(after)
            if t.get("vehicle_id")!=vid or t.get("view")!="observations": raise ValueError("invalid_cursor")
            if t.get("source_id")!=self._meta("source_id") or t.get("dataset_id")!=self._meta("dataset_id"): raise ValueError("reset_required")
            if t.get("scope")!=scope: raise ValueError("invalid_cursor")
            offset=int(t["offset"])
        c=self._c(); args=[vid]; where="o.vehicle_id=? AND o.deleted=0"
        join=""
        if record_id:
            if kind not in ("trip","charge"): raise ValueError("invalid_format")
            if not c.execute("SELECT 1 FROM records WHERE vehicle_id=? AND kind=? AND record_id=? AND deleted=0",(vid,kind,record_id)).fetchone(): raise ValueError("not_found")
            join=" JOIN record_observations ro ON ro.vehicle_id=o.vehicle_id AND ro.observation_id=o.observation_id"
            where+=" AND ro.record_id=? AND ro.kind=?"; args.extend([record_id,kind])
        rows=c.execute(f"SELECT o.* FROM observations o{join} WHERE {where} ORDER BY o.received_at_ms,o.observation_id LIMIT ? OFFSET ?",(*args,min(max(int(limit),1),200)+1,offset)).fetchall()
        lim=min(max(int(limit),1),200); more=len(rows)>lim; rows=rows[:lim]
        points=[{"observation_id":r["observation_id"],"vehicle_id":vid,"origin":r["origin"],"fidelity":r["fidelity"],"field_schema":r["field_schema"],"layout":r["layout"],"coordinate_system":r["coordinate_system"],"received_at_ms":r["received_at_ms"],"source_timestamps":json.loads(r["source_timestamps"]),"signals_raw":json.loads(r["signals_raw"]),"legacy_record":json.loads(r["legacy_record"]) if r["legacy_record"] else None} for r in rows]
        points_page=[]
        for point in points:
            if points_page and len(_json([*points_page,point]).encode("utf-8"))>500*1024: break
            if not points_page and len(_json(point).encode("utf-8"))>500*1024: raise ValueError("invalid_format")
            points_page.append(point)
        more=more or len(points_page)<len(points)
        nxt=self._token({"source_id":self._meta("source_id"),"dataset_id":self._meta("dataset_id"),"vehicle_id":vid,"view":"observations","scope":scope,"offset":offset+len(points_page)}) if more else None
        return {"points":points_page,"next_page_token":nxt,"has_more":more}

    def records_page(self, vid, after=None, limit=100, kind=None):
        self._require_vehicle(vid); offset=0
        scope=hashlib.sha256(_json(kind).encode()).hexdigest()
        if after:
            t=self._untoken(after)
            if t.get("vehicle_id")!=vid or t.get("view")!="records": raise ValueError("invalid_cursor")
            if t.get("source_id")!=self._meta("source_id") or t.get("dataset_id")!=self._meta("dataset_id"): raise ValueError("reset_required")
            if t.get("scope")!=scope: raise ValueError("invalid_cursor")
            offset=int(t["offset"])
        c=self._c(); args=[vid]; where="vehicle_id=? AND deleted=0"
        if kind:
            if kind not in ("trip","charge"): raise ValueError("invalid_format")
            where+=" AND kind=?"; args.append(kind)
        lim=min(max(int(limit),1),200); rows=c.execute(f"SELECT data FROM records WHERE {where} ORDER BY kind,record_id LIMIT ? OFFSET ?",(*args,lim+1,offset)).fetchall(); more=len(rows)>lim; rows=rows[:lim]
        return {"records":[json.loads(r[0]) for r in rows],"next_page_token":self._token({"source_id":self._meta("source_id"),"dataset_id":self._meta("dataset_id"),"vehicle_id":vid,"view":"records","scope":scope,"offset":offset+len(rows)}) if more else None,"has_more":more}

