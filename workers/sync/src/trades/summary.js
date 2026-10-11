// trade_summary for some officials, rebuilt from trades and trade_reports: the
// same SQL as summary_sql() in tools/load_trades.py. Pure (SQL text and binds),
// so the admin page can rebuild a summary when it publishes a transcription.
export function summaryStatements(officialIds) {
  const ids = [...new Set(officialIds)].filter(Boolean);
  if (!ids.length) return [];
  const q = ids.map(() => "?").join(", ");
  return [
    { sql: `DELETE FROM trade_summary WHERE official_id IN (${q})`, binds: ids },
    {
      sql: `INSERT INTO trade_summary (official_id, year, trades, total_min, total_max, open_ended, paper)
SELECT y.official_id, y.year, COALESCE(t.n, 0), COALESCE(t.lo, 0), CASE WHEN COALESCE(t.open, 0) > 0 THEN NULL ELSE COALESCE(t.hi, 0) END, COALESCE(t.open, 0), COALESCE(p.n, 0)
FROM (SELECT official_id, CAST(substr(transaction_date, 1, 4) AS INTEGER) AS year FROM trades WHERE official_id IN (${q}) AND transaction_date IS NOT NULL
      UNION SELECT official_id, CAST(substr(filed_on, 1, 4) AS INTEGER) FROM trade_reports WHERE official_id IN (${q}) AND paper = 1) y
LEFT JOIN (SELECT official_id, CAST(substr(transaction_date, 1, 4) AS INTEGER) AS year, COUNT(*) AS n, SUM(amount_min) AS lo, SUM(amount_max) AS hi,
           SUM(CASE WHEN amount_max IS NULL THEN 1 ELSE 0 END) AS open
           FROM trades WHERE official_id IN (${q}) AND transaction_date IS NOT NULL GROUP BY 1, 2) t ON t.official_id = y.official_id AND t.year = y.year
LEFT JOIN (SELECT official_id, CAST(substr(filed_on, 1, 4) AS INTEGER) AS year, COUNT(*) AS n FROM trade_reports WHERE official_id IN (${q}) AND paper = 1 GROUP BY 1, 2) p
  ON p.official_id = y.official_id AND p.year = y.year`,
      binds: [...ids, ...ids, ...ids, ...ids],
    },
  ];
}
