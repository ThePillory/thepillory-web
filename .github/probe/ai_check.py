#!/usr/bin/env python3
"""Temporary, read-only: today's sync run (AI steps) and scanned 278-T statuses."""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
import load_trades as T  # noqa: E402
class A: database = "pillory"
def q(label, sql):
    print(f"\n## {label}")
    try:
        for r in T.d1(A, command=sql):
            print(json.dumps(r, ensure_ascii=False)[:900])
    except Exception as e:  # noqa: BLE001
        print("ERROR", e)
q("Runs since 2026-10-12 10:00 UTC", "SELECT run_id, trigger, MIN(started_at) s, MAX(finished_at) f, COUNT(*) steps, SUM(status='error') errors, SUM(status='partial') partial FROM sync_log WHERE started_at >= '2026-10-12T10:00' GROUP BY run_id ORDER BY s")
q("Steps since 10:30 UTC, grouped", "SELECT step, status, COUNT(*) n, MIN(started_at) first, MAX(finished_at) last FROM sync_log WHERE started_at >= '2026-10-13T10:30' GROUP BY 1,2 ORDER BY MIN(id)")
q("AI step messages (latest each)", "SELECT step, status, started_at, substr(message,1,600) message FROM sync_log WHERE id IN (SELECT MAX(id) FROM sync_log WHERE started_at >= '2026-10-13T10:30' AND (step LIKE '%scan%' OR step LIKE 'plain%' OR step LIKE 'promise%' OR step LIKE '%issues%' OR step LIKE 'candidate-platforms' OR step LIKE 'order-analysis%' OR step LIKE 'agenda%' OR step LIKE 'topics' OR step LIKE 'analysis-round') GROUP BY step) ORDER BY id")
q("analysis-backlog errors by host", "SELECT substr(message, instr(message,'from https://')+13, 30) host, COUNT(*) n FROM sync_log WHERE step='analysis-backlog' AND started_at >= '2026-10-13T10:30' GROUP BY 1")
q("trade_scans by status", "SELECT status, spot_check, COUNT(*) n, MAX(read_at) last_read FROM trade_scans GROUP BY 1,2")
q("trade_scans read since Oct 12", "SELECT s.report_id, s.status, s.text_rows, s.models, s.read_at, s.reviewed_by, substr(s.problems,1,300) problems, r.transcribed_at, r.transcribed_by FROM trade_scans s LEFT JOIN trade_reports r ON r.id = s.report_id WHERE s.read_at >= '2026-10-12' ORDER BY s.read_at")
q("Scanned reports published (transcribed)", "SELECT COUNT(*) n, SUM(transcribed_by IS NOT NULL) checked_by_person FROM trade_reports WHERE transcribed_at IS NOT NULL")
