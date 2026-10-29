
=== /votes/: 904 ms, HTTP 200, 22636 bytes, 2 queries, 310342 rows read
   711 ms  d1   329 ms     310313 rows  SELECT v.*, b.bill_number, b.title AS bill_title FROM votes v LEFT JOIN bills b ON b.id = v.bill_id WHERE v.vo
   139 ms  d1     0 ms         29 rows  SELECT a.bill_id, a.clauses FROM bill_analyses a WHERE a.current = 1 AND (a.status = 'reviewed' OR (a.status =

=== /votes/?level=federal: 504 ms, HTTP 200, 19248 bytes, 3 queries, 160 rows read
   171 ms  d1     2 ms         95 rows  SELECT v.*, b.bill_number, b.title AS bill_title FROM votes v LEFT JOIN bills b ON b.id = v.bill_id WHERE v.vo
   166 ms  d1     6 ms         55 rows  SELECT a.bill_id, a.clauses FROM bill_analyses a WHERE a.current = 1 AND (a.status = 'reviewed' OR (a.status =
   165 ms  d1     1 ms         10 rows  SELECT id, label FROM constitution_provisions WHERE id IN (?,?,?,?,?)

=== /calaveras/: 959 ms, HTTP 200, 12933 bytes, 5 queries, 207445 rows read
   438 ms  d1   121 ms     207113 rows  SELECT v.*, b.bill_number, b.title AS bill_title FROM ( SELECT * FROM votes v WHERE v.vote_type = 'final_passa
   182 ms  d1     0 ms          1 rows  SELECT value FROM sync_state WHERE key = 'home_districts'
   161 ms  d1     3 ms        247 rows  SELECT o.*, s.vote_count AS vote_count FROM officials o LEFT JOIN official_stats s ON s.official_id = o.id WHE
   142 ms  d1     0 ms          1 rows  SELECT * FROM meetings WHERE starts_at >= ? AND starts_at <= ? AND (? IS NULL OR level = ?) ORDER BY starts_at
   130 ms  d1     1 ms         83 rows  SELECT p.vote_id, p.position, p.raw_position, o.name, o.slug, o.office, o.district FROM all_positions p JOIN o

=== /ballot/ca/: 224 ms, HTTP 200, 62099 bytes, 2 queries, 596 rows read
   207 ms  d1     2 ms        271 rows  SELECT slug, name, last_name, office, district, district_code, level, chamber, active, state, senate_class FRO
   170 ms  d1    12 ms        325 rows  SELECT f.candidate_id, o.slug, o.name, o.office, o.district, o.active, o.level FROM fec_candidates f JOIN offi

=== /briefing/: 590 ms, HTTP 200, 11828 bytes, 4 queries, 207444 rows read
   255 ms  d1   114 ms     207113 rows  SELECT v.*, b.bill_number, b.title AS bill_title FROM ( SELECT * FROM votes v WHERE v.vote_type = 'final_passa
   172 ms  d1     1 ms         83 rows  SELECT p.vote_id, p.position, p.raw_position, o.name, o.slug, o.office, o.district FROM all_positions p JOIN o
   160 ms  d1     1 ms        247 rows  SELECT o.*, s.vote_count AS vote_count FROM officials o LEFT JOIN official_stats s ON s.official_id = o.id WHE
   128 ms  d1     0 ms          1 rows  SELECT * FROM meetings WHERE starts_at >= ? AND starts_at <= ? AND (? IS NULL OR level = ?) ORDER BY starts_at
