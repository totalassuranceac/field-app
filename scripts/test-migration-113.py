# Run: python scripts/test-migration-113.py   (stdlib only; throwaway in-memory DB; never touches D1)
import sqlite3, sys, pathlib
p = pathlib.Path("migrations/113_tech_assist.sql")
raw = p.read_bytes()
fails = 0
def check(name, ok):
    global fails
    print(("PASS " if ok else "FAIL ") + name)
    if not ok: fails += 1
check("LF only", b"\r" not in raw)
check("ASCII only", all(b < 128 for b in raw))
db = sqlite3.connect(":memory:")
db.executescript(raw.decode())
db.executescript(raw.decode())  # idempotent
names = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
for t in ("tech_equipment_snaps", "tech_job_wrapups", "tech_brief_cache"):
    check("table " + t, t in names)
idx = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='index'")}
for i in ("idx_tech_equip_loc", "idx_tech_equip_addr", "idx_tech_equip_job", "idx_tech_wrapups_job", "idx_tech_wrapups_user"):
    check("index " + i, i in idx)
now = "2026-10-02T13:00:00.000Z"
db.execute("INSERT INTO tech_equipment_snaps (st_job_id, unit_role, source, created_by, created_at) VALUES ('1','outdoor','ocr',3,?)", (now,))
for bad_sql, args in [
    ("INSERT INTO tech_equipment_snaps (st_job_id, unit_role, source, created_by, created_at) VALUES ('1','roof','ocr',3,?)", (now,)),
    ("INSERT INTO tech_equipment_snaps (st_job_id, source, created_by, created_at) VALUES ('1','camera',3,?)", (now,)),
    ("INSERT INTO tech_equipment_snaps (st_job_id, source, decode_confidence, created_by, created_at) VALUES ('1','typed','sure',3,?)", (now,)),
    ("INSERT INTO tech_job_wrapups (st_job_id, user_id, raw_text, split_by, created_at, updated_at) VALUES ('1',3,'x','gpt',?,?)", (now, now)),
    ("INSERT INTO tech_job_wrapups (st_job_id, user_id, raw_text, input, created_at, updated_at) VALUES ('1',3,'x','video',?,?)", (now, now)),
]:
    try:
        db.execute(bad_sql, args); check("CHECK rejects: " + bad_sql[:60], False)
    except sqlite3.IntegrityError:
        check("CHECK rejects: " + bad_sql[12:60], True)
db.execute("INSERT INTO tech_brief_cache (st_job_id, built_at, brief_json) VALUES ('9',?,'{}')", (now,))
try:
    db.execute("INSERT INTO tech_brief_cache (st_job_id, built_at, brief_json) VALUES ('9',?,'{}')", (now,)); check("brief cache PK unique", False)
except sqlite3.IntegrityError:
    check("brief cache PK unique", True)
print("FAILS:", fails)
sys.exit(1 if fails else 0)
