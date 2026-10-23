"""Offline contract tests for the standalone raw sync archive."""
import json
import importlib.util
from pathlib import Path
import sqlite3

import pytest

_SPEC=importlib.util.spec_from_file_location("sync_archive",Path(__file__).parents[1]/"custom_components"/"leapmotor"/"sync_archive.py")
_MODULE=importlib.util.module_from_spec(_SPEC); _SPEC.loader.exec_module(_MODULE)
SyncArchive=_MODULE.SyncArchive


def archive(tmp_path):
    a=SyncArchive(tmp_path/"archive.sqlite")
    a.open()
    va=a.ensure_vehicle(" vin-a ")
    vb=a.ensure_vehicle("vin-b")
    return a,va,vb


def test_vehicle_scoped_records_and_cursor(tmp_path):
    a,va,vb=archive(tmp_path)
    a.put_record(va,"trip","same-id",{"record_id":"same-id","kind":"trip","distance_km":99})
    a.put_record(vb,"trip","same-id",{"record_id":"same-id","kind":"trip"})
    ca=a.bootstrap(va)["cursor"]
    assert len(a.pull(va,ca)["changes"])==0
    with pytest.raises(ValueError): a.pull(vb,ca)
    with pytest.raises(ValueError): a.observations("missing")
    assert "distance_km" not in a.records_page(va)["records"][0]
    a.close(); a.shutdown()


def test_raw_dedup_restart_and_more_than_3000_samples(tmp_path):
    path=tmp_path/"a.sqlite"; a=SyncArchive(path); a.open(); vid=a.ensure_vehicle("VIN1")
    first=a.ingest(vid,"signal_map",{"2":"1","3":"2","token":"SECRET"},{"collectTime":1},2000,"gcj02")
    assert a.ingest(vid,"signal_map",{"2":"1","3":"2","token":"SECRET"},{"collectTime":1},2001,"gcj02")==first
    for i in range(3100): a.ingest(vid,"signal_map",{"2":str(i),"1178":i},{"collectTime":i+2},i+3,"gcj02")
    a.close(); a.shutdown()
    b=SyncArchive(path); b.open(); assert b.ensure_vehicle("vin1")==vid
    got=[]; token=None
    while True:
        page=b.observations(vid,token,200); got.extend(page["points"])
        if not page["has_more"]: break
        token=page["next_page_token"]
    assert len(got)==3101
    assert all("token" not in json.dumps(row) for row in got)
    # The primary sync path also carries every point, including >1024 current samples.
    snapshot=b.bootstrap(vid,limit=200); items=list(snapshot["items"])
    while snapshot["has_more"]:
        snapshot=b.bootstrap(vid,snapshot["next_page_token"],200)
        items.extend(snapshot["items"])
    points=[item["data"] for item in items if item["entity_type"]=="observation"]
    assert len(points)==3101
    assert sum("1178" in point["signals_raw"] for point in points)==3100
    assert b.pull(vid,snapshot["cursor"])["changes"]==[]
    b.close(); b.shutdown()


def test_snapshot_is_materialized_through_delete_and_new_sample(tmp_path):
    a,vid,_=archive(tmp_path)
    oid=a.ingest(vid,"signal_map",{"2":"1"},{"collectTime":1},1,"gcj02")
    second_id=a.ingest(vid,"signal_map",{"2":"1.5"},{"collectTime":1.5},2,"gcj02")
    first=a.bootstrap(vid,limit=1)
    # Snapshot holds the old committed state even if it is deleted after page one.
    a.delete_entity(vid,"observation",oid)
    new_id=a.ingest(vid,"signal_map",{"2":"2"},{"collectTime":2},3,"gcj02")
    assert first["has_more"] is True
    items=list(first["items"])
    page=first
    while page["has_more"]:
        page=a.bootstrap(vid,page["next_page_token"],1)
        items.extend(page["items"])
    assert {i["data"]["observation_id"] for i in items if i["entity_type"]=="observation"}=={oid,second_id}
    changes=a.pull(vid,page["cursor"])["changes"]
    assert any(c["op"]=="observation.delete" and c["entity_id"]==oid for c in changes)
    assert any(c["op"]=="observation.upsert" and c["entity_id"]==new_id for c in changes)
    assert {p["observation_id"] for p in a.observations(vid)["points"]}=={second_id,new_id}
    a.close(); a.shutdown()


def test_transaction_rolls_back_sample_when_change_append_fails(tmp_path,monkeypatch):
    a,vid,_=archive(tmp_path)
    original=a._event
    def fail(*args): raise sqlite3.OperationalError("disk full")
    monkeypatch.setattr(a,"_event",fail)
    with pytest.raises(sqlite3.OperationalError): a.ingest(vid,"signal_map",{"2":"1"},{"collectTime":1},1)
    assert a._c().execute("SELECT COUNT(*) FROM observations").fetchone()[0]==0
    assert a._c().execute("SELECT COUNT(*) FROM changes").fetchone()[0]==0
    monkeypatch.setattr(a,"_event",original)
    a.close(); a.shutdown()


def test_snapshot_page_token_scope_and_expiry(tmp_path):
    a,va,vb=archive(tmp_path)
    for i in range(3): a.ingest(va,"signal_map",{"2":str(i)},{"collectTime":i},i)
    page=a.bootstrap(va,limit=1)
    with pytest.raises(ValueError): a.bootstrap(vb,page["next_page_token"],1)
    token=a._untoken(page["next_page_token"])
    a._c().execute("UPDATE snapshots SET expires=0 WHERE snapshot_id=?",(token["snapshot_id"],))
    with pytest.raises(ValueError,match="snapshot_expired"): a.bootstrap(va,page["next_page_token"],1)
    a.close(); a.shutdown()


def test_legacy_import_idempotent_excludes_derived_charge_values(tmp_path):
    a,vid,_=archive(tmp_path)
    assert a.import_legacy(vid,"charge","charge-1",[[10,55]],{"started_at":10})==1
    assert a.import_legacy(vid,"charge","charge-1",[[10,55]],{"started_at":10})==0
    row=a.observations(vid)["points"][0]
    assert row["fidelity"]=="legacy_partial"
    assert row["signals_raw"]=={"legacy_soc_percent":55}
    assert "power" not in json.dumps(row)
    a.close(); a.shutdown()


def test_missing_or_invalid_source_time_never_deduplicates(tmp_path):
    a,vid,_=archive(tmp_path)
    for stamp in ({},{"sts":None},{"sts":""},{"sts":0},{"sts":"unparseable"}):
        first=a.ingest(vid,"signal_map",{"2":"1"},stamp,100)
        second=a.ingest(vid,"signal_map",{"2":"1"},stamp,101)
        assert first!=second
    assert len(a.observations(vid,limit=200)["points"])==10
    a.close(); a.shutdown()


def test_same_record_id_has_separate_points_and_foreign_members_are_rejected(tmp_path):
    a,va,vb=archive(tmp_path)
    pa=a.ingest(va,"signal_map",{"1204":"50"},{"sts":1},1)
    pb=a.ingest(vb,"signal_map",{"1204":"80"},{"sts":1},1)
    for vid,point in ((va,pa),(vb,pb)):
        a.associate_observation(vid,"trip","same",point,"recording",1)
    assert a.observations(va,record_id="same",kind="trip")["points"][0]["observation_id"]==pa
    assert a.observations(vb,record_id="same",kind="trip")["points"][0]["observation_id"]==pb
    with pytest.raises(ValueError,match="not_found"):
        a.associate_observation(vb,"trip","same",pa,"completed",1,2)
    with pytest.raises(ValueError,match="not_found"):
        a.observations(va,record_id="absent",kind="trip")
    # The same raw ID also remains distinct between trip and charge.
    a.associate_observation(va,"charge","same",pa,"completed",1,2)
    assert len(a.records_page(va)["records"])==2
    a.close(); a.shutdown()


def test_group_completion_with_reused_sample_and_native_restart_import(tmp_path):
    a,vid,_=archive(tmp_path)
    point=a.ingest(vid,"signal_map",{"1204":40},{"collectTime":1},1)
    a.associate_observation(vid,"charge","one",point,"recording",1)
    cursor=a.bootstrap(vid)["cursor"]
    a.associate_observation(vid,"charge","one",point,"completed",1,2)
    row=a.records_page(vid)["records"][0]
    assert row["phase"]=="completed" and row["revision"]==2
    assert len(a.observations(vid,record_id="one",kind="charge")["points"])==1
    assert a.import_legacy(vid,"charge","one",[[1,40]],{})==0
    assert len(a.observations(vid)["points"])==1
    assert a.pull(vid,cursor)["changes"][0]["data"]["phase"]=="completed"
    a.close(); a.shutdown()


def test_filter_tokens_and_forged_tokens_are_rejected(tmp_path):
    a,va,vb=archive(tmp_path)
    for i in range(3):
        a.ingest(va,"signal_map",{"1204":i},{"sts":i+1},i)
        a.put_record(va,"trip",str(i),{"phase":"completed"})
    token=a.observations(va,limit=1)["next_page_token"]
    with pytest.raises(ValueError,match="invalid_cursor"): a.observations(vb,token)
    with pytest.raises(ValueError,match="invalid_cursor"): a.observations(va,token,record_id="0",kind="trip")
    token=a.records_page(va,limit=1)["next_page_token"]
    with pytest.raises(ValueError,match="invalid_cursor"): a.records_page(va,token,kind="charge")
    with pytest.raises(ValueError,match="invalid_cursor"): a.records_page(vb,token)
    with pytest.raises(ValueError,match="invalid_cursor"): a.pull(va,token)
    with pytest.raises(ValueError,match="invalid_cursor"): a.pull(va,"tampered")
    with pytest.raises(ValueError,match="invalid_cursor"): a.pull(va,None)
    a.close(); a.shutdown()


def test_provider_times_and_values_are_preserved_and_distinct(tmp_path):
    a,vid,_=archive(tmp_path)
    original={"longitude":"120.123456789", "soc":0, "bcmKeyPositionOn3":False, "batteryCurrent":"-2.5", "token":"secret"}
    stamp={"data.collectTimeMs":"1000", "source.sts":"2000"}
    first=a.ingest(vid,"named_signal",original,stamp,5,"gcj02")
    assert a.ingest(vid,"named_signal",original,stamp,6,"gcj02")==first
    assert a.ingest(vid,"named_signal",original,{**stamp,"source.sts":"2001"},7,"gcj02")!=first
    assert a.ingest(vid,"named_signal",{**original,"soc":1},stamp,8,"gcj02")!=first
    row=next(p for p in a.observations(vid)["points"] if p["observation_id"]==first)
    assert row["signals_raw"]=={k:v for k,v in original.items() if k!="token"}
    assert row["source_timestamps"]==stamp
    assert row["received_at_ms"]==5
    assert a.info()["fields"]["1178"]["unit"]=="A"
    a.close(); a.shutdown()


def test_recovery_and_restart_keep_identity_and_cursor(tmp_path):
    path=tmp_path/"restart.sqlite"
    a=SyncArchive(path); a.run("open"); vid=a.run("ensure_vehicle","VIN")
    a.run("ingest",vid,"signal_map",{"1204":5},{"sts":1},1)
    info=a.run("info"); cursor=a.run("bootstrap",vid)["cursor"]
    a.ready=False; a.run("recover")
    assert a.run("info")["dataset_id"]==info["dataset_id"]
    assert any(c["data"].get("event")=="archive_recovered" for c in a.run("pull",vid,cursor)["changes"])
    a.run("close"); a.shutdown()
    b=SyncArchive(path); b.run("open")
    assert b.run("ensure_vehicle"," vin ")==vid
    assert b.run("info")["source_id"]==info["source_id"]
    assert b.run("pull",vid,cursor)["changes"]
    b.run("close"); b.shutdown()


def test_restore_then_regrow_rejects_cursor_from_abandoned_branch(tmp_path):
    import shutil
    path,backup=tmp_path/"live.sqlite",tmp_path/"backup.sqlite"
    a=SyncArchive(path); a.open(); vid=a.ensure_vehicle("VIN")
    a.ingest(vid,"signal_map",{"1204":1},{"sts":1},1)
    target=sqlite3.connect(backup); a._c().backup(target); target.close()
    a.ingest(vid,"signal_map",{"1204":2},{"sts":2},2)
    abandoned=a.bootstrap(vid)["cursor"]
    a.close(); a.shutdown(); shutil.copyfile(backup,path)
    b=SyncArchive(path); b.open()
    b.ingest(vid,"signal_map",{"1204":3},{"sts":3},3)
    with pytest.raises(ValueError,match="reset_required"): b.pull(vid,abandoned)
    b.close(); b.shutdown()


def test_byte_limited_pages_include_every_raw_sample(tmp_path):
    a,vid,_=archive(tmp_path); cursor=a.bootstrap(vid)["cursor"]
    ids={a.ingest(vid,"signal_map",{"2":"x"*40000,"1178":i},{"sts":i+1},i) for i in range(20)}
    all_changes=[]
    while True:
        page=a.pull(vid,cursor,200)
        assert len(json.dumps(page,ensure_ascii=False).encode())<512*1024
        all_changes.extend(page["changes"]); cursor=page["next_cursor"]
        if not page["has_more"]: break
    assert {c["entity_id"] for c in all_changes if c["op"]=="observation.upsert"}==ids
    points=[]; after=None
    while True:
        page=a.observations(vid,after,200)
        assert len(json.dumps(page,ensure_ascii=False).encode())<512*1024
        points.extend(page["points"])
        if not page["has_more"]: break
        after=page["next_page_token"]
    assert {p["observation_id"] for p in points}==ids
    a.close(); a.shutdown()


def test_record_snapshot_keeps_old_versions_and_separates_trip_charge_ids(tmp_path):
    a,vid,_=archive(tmp_path)
    a.put_record(vid,"trip","same",{"phase":"recording","revision":1})
    a.put_record(vid,"charge","same",{"phase":"completed","revision":1})
    page=a.bootstrap(vid,limit=1); items=list(page["items"])
    a.put_record(vid,"trip","same",{"phase":"completed","revision":2})
    a.delete_entity(vid,"record","same","charge")
    while page["has_more"]:
        page=a.bootstrap(vid,page["next_page_token"],1); items.extend(page["items"])
    records={item["data"]["kind"]:item["data"] for item in items}
    assert records["trip"]["phase"]=="recording" and records["charge"]["phase"]=="completed"
    changes=a.pull(vid,page["cursor"])["changes"]
    assert [(c["op"],c["data"]["kind"]) for c in changes]==[("record.upsert","trip"),("record.delete","charge")]
    current=a.bootstrap(vid)["items"]
    assert len(current)==1 and current[0]["data"]["kind"]=="trip" and current[0]["data"]["revision"]==2
    a.close(); a.shutdown()


def test_pending_legacy_import_does_not_resurrect_a_deleted_ha_record(tmp_path):
    a,vid,_=archive(tmp_path)
    a.delete_entity(vid,"record","pending","trip",True)
    assert a.import_legacy(vid,"trip","pending",[[30,120,0,10,50]],{})==0
    assert a.records_page(vid)["records"]==[]
    assert a.observations(vid)["points"]==[]
    assert a.bootstrap(vid)["items"]==[]
    a.close(); a.shutdown()


def test_ha_stop_only_marks_currently_loaded_vehicle_collectors(tmp_path):
    a,va,vb=archive(tmp_path)
    a.add_stop_events([va])
    assert [i["data"]["event"] for i in a.bootstrap(va)["items"]]==["collector_stopped"]
    assert a.bootstrap(vb)["items"]==[]
    a.close(); a.shutdown()

