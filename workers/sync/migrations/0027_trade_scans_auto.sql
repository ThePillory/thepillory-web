-- Scanned 278-T transcriptions publish once both AI readings agree and the
-- checks pass, labeled "Transcribed by AI from a scanned report, auto-checked"
-- (like AI-drafted analyses). In trade_scans, 'agreed' now means published by
-- the AI step, 'approved' confirmed by a person ("Checked by [name]"), and
-- 'rejected' taken down by a person (the report is a link again). A share
-- (SPOT_CHECK_RATE) is marked for a person to look at.
ALTER TABLE trade_scans ADD COLUMN spot_check INTEGER NOT NULL DEFAULT 0;
