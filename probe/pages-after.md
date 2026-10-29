
=== /votes/: 2609 ms, HTTP 200, 22636 bytes, 2 queries, 310342 rows read
  2349 ms  d1  1765 ms     310313 rows  SELECT v.*, b.bill_number, b.title AS bill_title FROM votes v LEFT JOIN bills b ON b.id = v.bill_id WHERE v.vo
   167 ms  d1     1 ms         29 rows  SELECT a.bill_id, a.clauses FROM bill_analyses a WHERE a.current = 1 AND (a.status = 'reviewed' OR (a.status =

=== /votes/?level=federal: 504 ms, HTTP 200, 19248 bytes, 3 queries, 160 rows read
   176 ms  d1     6 ms         55 rows  SELECT a.bill_id, a.clauses FROM bill_analyses a WHERE a.current = 1 AND (a.status = 'reviewed' OR (a.status =
   168 ms  d1     2 ms         10 rows  SELECT id, label FROM constitution_provisions WHERE id IN (?,?,?,?,?)
   159 ms  d1     1 ms         95 rows  SELECT v.*, b.bill_number, b.title AS bill_title FROM votes v LEFT JOIN bills b ON b.id = v.bill_id WHERE v.vo
section "briefing votes" failed: SectionTimeout: took longer than 3000 ms

=== /calaveras/: 3303 ms, HTTP 200, 10177 bytes, 3 queries, 249 rows read
   464 ms  d1     7 ms        247 rows  SELECT o.*, s.vote_count AS vote_count FROM officials o LEFT JOIN official_stats s ON s.official_id = o.id WHE
   194 ms  d1     1 ms          1 rows  SELECT value FROM sync_state WHERE key = 'home_districts'
   125 ms  d1     0 ms          1 rows  SELECT * FROM meetings WHERE starts_at >= ? AND starts_at <= ? AND (? IS NULL OR level = ?) ORDER BY starts_at

=== /ballot/ca/: 275 ms, HTTP 200, 62099 bytes, 3 queries, 90279 rows read
  2444 ms  d1  2298 ms      89683 rows  SELECT v.*, b.bill_number, b.title AS bill_title FROM ( SELECT p.vote_id AS id FROM vote_positions p WHERE p.o
   258 ms  d1     3 ms        271 rows  SELECT slug, name, last_name, office, district, district_code, level, chamber, active, state, senate_class FRO
   204 ms  d1     5 ms        325 rows  SELECT f.candidate_id, o.slug, o.name, o.office, o.district, o.active, o.level FROM fec_candidates f JOIN offi

=== /briefing/: 625 ms, HTTP 200, 11828 bytes, 5 queries, 90097 rows read
   244 ms  d1   121 ms      89683 rows  SELECT v.*, b.bill_number, b.title AS bill_title FROM ( SELECT p.vote_id AS id FROM vote_positions p WHERE p.o
   234 ms  d1     0 ms          1 rows  SELECT * FROM meetings WHERE starts_at >= ? AND starts_at <= ? AND (? IS NULL OR level = ?) ORDER BY starts_at
   209 ms  d1     1 ms         83 rows  SELECT p.vote_id, p.position, p.raw_position, o.name, o.slug, o.office, o.district FROM all_positions p JOIN o
   168 ms  d1     2 ms        247 rows  SELECT o.*, s.vote_count AS vote_count FROM officials o LEFT JOIN official_stats s ON s.official_id = o.id WHE
   158 ms  d1     2 ms         83 rows  SELECT p.vote_id, p.position, p.raw_position, o.name, o.slug, o.office, o.district FROM all_positions p JOIN o
