#!/usr/bin/env python3
"""Temporary, read-only: what used the Claude API on October 11-13, 2026 (UTC)."""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
import load_trades as T  # noqa: E402
class A: database = "pillory"
def q(label, sql):
    print(f"\n## {label}")
    try:
        for r in T.d1(A, command=sql): print(json.dumps(r, ensure_ascii=False)[:700])
    except Exception as e: print("ERROR", e)
AI = "('relevance','relevance-skip','analysis-round','analysis-backlog','analysis','order-analysis','topics','plain-summaries','scanned-trades','promise-suggestions','promise-status','promises','issues-pages','candidate-platforms','agenda-watch','agenda')"
q("Runs Oct 11-13 (UTC)", "SELECT run_id, trigger, MIN(started_at) s, MAX(finished_at) f, COUNT(*) steps FROM sync_log WHERE started_at >= '2026-10-11' AND started_at < '2026-10-14' GROUP BY run_id ORDER BY s")
q("AI-ish steps per day (UTC)", f"SELECT substr(started_at,1,10) day, step, COUNT(*) n, SUM(status='ok') ok, SUM(status='error') err FROM sync_log WHERE started_at >= '2026-10-11' AND started_at < '2026-10-14' AND (step IN {AI} OR step LIKE '%analysis%' OR step LIKE 'promise%' OR step LIKE 'plain%' OR step LIKE '%scan%' OR step LIKE 'topic%' OR step LIKE 'agenda%') GROUP BY 1,2 ORDER BY 1,2")
q("Every distinct step name Oct 12", "SELECT step, COUNT(*) n FROM sync_log WHERE started_at >= '2026-10-12' AND started_at < '2026-10-13' GROUP BY 1 ORDER BY n DESC")
q("Messages of AI steps Oct 12 (latest per step per run)", f"SELECT run_id, step, status, started_at, substr(message,1,400) m FROM sync_log WHERE id IN (SELECT MAX(id) FROM sync_log WHERE started_at >= '2026-10-12' AND started_at < '2026-10-13' AND (step LIKE '%analysis%' OR step LIKE 'promise%' OR step LIKE 'plain%' OR step LIKE '%scan%' OR step LIKE 'topic%' OR step LIKE 'agenda%' OR step LIKE 'relevance%' OR step LIKE 'candidate%' OR step LIKE 'issues%') GROUP BY run_id, step) ORDER BY started_at")
q("Analyses drafted per day", "SELECT substr(created_at,1,10) day, COUNT(*) n FROM analysis_drafts WHERE created_at >= '2026-10-10' GROUP BY 1")
q("Topic tags per day", "SELECT substr(tagged_at,1,10) day, COUNT(*) n FROM item_topics WHERE tagged_at >= '2026-10-10' GROUP BY 1")
q("Scanned 278-T chunks read", "SELECT model, COUNT(*) n FROM trade_scan_chunks GROUP BY 1")
q("Net worth scan chunks", "SELECT model, COUNT(*) n FROM networth_scan_chunks GROUP BY 1")
q("Net worth scans", "SELECT report_id, status, read_at FROM networth_scans")
