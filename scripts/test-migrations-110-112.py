import sqlite3, sys
db=sqlite3.connect(":memory:")
db.executescript("""
CREATE TABLE users(id INTEGER PRIMARY KEY);
CREATE TABLE vehicles(id INTEGER PRIMARY KEY);
CREATE TABLE vehicle_issues(id INTEGER PRIMARY KEY);
CREATE TABLE parts_order_requests(id INTEGER PRIMARY KEY);
CREATE TABLE warranty_claims(id INTEGER PRIMARY KEY);
CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
INSERT INTO users VALUES(7),(8);INSERT INTO vehicles VALUES(15);INSERT INTO vehicle_issues VALUES(1),(2);INSERT INTO warranty_claims VALUES(59);
""")
files=["migrations/110_vendor_handoffs.sql","migrations/111_fleet_shop.sql","migrations/112_done_today.sql"]
for f in files:
    s=open(f).read(); assert "\r" not in s, f
for rnd in (1,2):
    for f in files: db.executescript(open(f).read())
    print("run",rnd,"ok")
objs=db.execute("select type,count(*) from sqlite_master where name like 'fleet_%' or name like '%fleet_%' or name like 'done_today%' or name like '%done_today%' group by type").fetchall()
print("fleet/done objects:",objs)
print("vendor objs:",db.execute("select type,name from sqlite_master where name like '%vendor_handoff%' order by 1,2").fetchall())
fails=0
def bad(q,label):
    global fails
    try: db.execute(q); print("FAIL accepted:",label); fails+=1
    except (sqlite3.IntegrityError, sqlite3.DatabaseError) as e: print("ok rejects", label, "->", str(e)[:50])
def good(q,label):
    global fails
    try: db.execute(q); print("ok accepts",label)
    except Exception as e: print("FAIL rejected:",label,e); fails+=1
good("insert into fleet_wrench_segments(user_id,entry_type,issue_id,started_at) values(7,'work_order',1,'2026-10-01T14:00:00.000Z')","open WO timer")
bad("insert into fleet_wrench_segments(user_id,entry_type,started_at) values(7,'shop','2026-10-01T15:00:00.000Z')","2nd open timer")
good("insert into fleet_wrench_segments(user_id,entry_type,category,started_at,ended_at,end_reason) values(7,'shop','parts_run','2026-10-01T12:00:00.000Z','2026-10-01T13:00:00.000Z','switch')","closed shop segment")
bad("insert into fleet_wrench_segments(user_id,entry_type,started_at,ended_at,end_reason) values(7,'work_order','2026-10-01T12:00:00.000Z','2026-10-01T13:00:00.000Z','done')","WO segment without issue")
bad("insert into fleet_wrench_segments(user_id,entry_type,issue_id,started_at,ended_at,end_reason) values(7,'shop',1,'2026-10-01T12:00:00.000Z','2026-10-01T13:00:00.000Z','done')","shop segment with issue")
bad("insert into fleet_wrench_segments(user_id,entry_type,started_at,ended_at,end_reason) values(8,'Shop!','2026-10-01T12:00:00.000Z','2026-10-01T13:00:00.000Z','pause')","bad entry_type text")
bad("insert into fleet_wrench_segments(user_id,entry_type,started_at,ended_at,end_reason) values(8,'shop','2026-10-01T13:00:00.000Z','2026-10-01T12:00:00.000Z','pause')","ended before started")
bad("insert into fleet_wrench_segments(user_id,entry_type,started_at,ended_at) values(8,'shop','2026-10-01T12:00:00.000Z','2026-10-01T13:00:00.000Z')","ended w/o reason")
good("insert into fleet_wo_meta(issue_id,vehicle_id,kind,pm_code,pm_open_key,source) values(1,15,'pm','oil','15:oil','pm_auto')","open PM")
bad("insert into fleet_wo_meta(issue_id,vehicle_id,kind,pm_code,pm_open_key,source) values(2,15,'pm','oil','15:oil','pm_auto')","duplicate open PM")
bad("insert into fleet_wo_meta(issue_id,vehicle_id,kind,source) values(2,15,'pm','pm_auto')","PM without code")
good("insert into fleet_wo_stage_events(issue_id,stage,at,actor_user_id,source) values(1,'started','2026-10-01 14:00:00',7,'fleet_shop')","stage row")
bad("update fleet_wo_stage_events set stage='done'","stage UPDATE")
bad("delete from fleet_wo_stage_events","stage DELETE")
bad("insert into fleet_wo_stage_events(issue_id,stage,at,source) values(1,'teleported','2026-10-01 14:00:00','fleet_shop')","unknown stage")
bad("insert into fleet_wo_photos(issue_id,photo_key,uploaded_by_user_id) values(1,'fuel-receipts/x.jpg',7)","non issue-photos key")
bad("insert into fleet_wo_parts(issue_id,description,added_by_user_id) values(1,'  ',7)","blank part")
bad("insert into fleet_odometer_readings(vehicle_id,odometer,read_on,source,user_id) values(15,0,'2026-10-01','shop_confirm',7)","zero odometer")
good("insert into done_today_extras(user_id,day_ct,body,input,split_by) values(7,'2026-10-01','Swept the bay','spoken','rules')","extra line")
bad("insert into done_today_extras(user_id,day_ct,body) values(7,'10/01/2026','x')","bad day format")
bad("insert into done_today_extras(user_id,day_ct,body) values(7,'2026-10-01','   ')","blank extra")
bad("insert into done_today_extras(user_id,day_ct,body) values(7,'2026-10-01','"+"x"*201+"')","201-char extra")
print("settings:",db.execute("select key from settings where key like 'fleet_shop%' or key like 'done_today%' order by key").fetchall())
print("pm types:",db.execute("select code,interval_miles,interval_days from fleet_pm_types order by sort_order").fetchall())
print("FAILS",fails); sys.exit(1 if fails else 0)
