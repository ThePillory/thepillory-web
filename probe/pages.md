
=== /: 726 ms, HTTP 200, 19128 bytes, 7 queries, 2835 rows read
   175 ms  d1     4 ms       2690 rows  SELECT o.bill_id, o.outcome, o.action_date, b.bill_number, b.title, b.level FROM bill_outcomes o JOIN bills b 
   160 ms  d1     0 ms          6 rows  SELECT id, title, signed_on, id LIKE 'fr:%' AS federal FROM executive_actions WHERE kind = 'executive_order' A
   152 ms  d1     0 ms          1 rows  SELECT v.id, v.bill_id, v.chamber, v.result, v.vote_date, v.level, b.bill_number, b.title AS bill_title FROM b
   150 ms  d1     1 ms         55 rows  SELECT * FROM officials WHERE chamber = ? AND active = 1 ORDER BY rank, name
   146 ms  d1     0 ms          3 rows  SELECT county_fips, COUNT(*) AS n FROM waitlist GROUP BY county_fips
   145 ms  d1     2 ms         79 rows  SELECT v.id, v.bill_id, v.chamber, v.result, v.vote_date, v.level, b.bill_number, b.title AS bill_title FROM b
   111 ms  d1     0 ms          1 rows  SELECT item_id, what FROM plain_summaries WHERE kind = 'bill' AND item_id IN (?,?,?,?,?,?,?,?,?,?)

=== /states/california/: 520 ms, HTTP 200, 31490 bytes, 9 queries, 2857 rows read
   312 ms  d1     1 ms         55 rows  SELECT * FROM officials WHERE chamber = ? AND active = 1 ORDER BY rank, name
   312 ms  d1     0 ms          1 rows  SELECT v.id, v.bill_id, v.chamber, v.result, v.vote_date, v.level, b.bill_number, b.title AS bill_title FROM b
   311 ms  d1     1 ms       2690 rows  SELECT o.bill_id, o.outcome, o.action_date, b.bill_number, b.title, b.level FROM bill_outcomes o JOIN bills b 
   311 ms  d1     0 ms          3 rows  SELECT county_fips, COUNT(*) AS n FROM waitlist GROUP BY county_fips
   311 ms  d1     0 ms          6 rows  SELECT id, title, signed_on, id LIKE 'fr:%' AS federal FROM executive_actions WHERE kind = 'executive_order' A
   310 ms  d1     0 ms         79 rows  SELECT v.id, v.bill_id, v.chamber, v.result, v.vote_date, v.level, b.bill_number, b.title AS bill_title FROM b
   112 ms  d1     1 ms         17 rows  SELECT * FROM officials WHERE chamber = ? AND active = 1 ORDER BY rank, name
    97 ms  d1     0 ms          5 rows  SELECT id, slug, name, office, chamber, district FROM officials WHERE active = 1 AND state = ? AND chamber = '
    88 ms  d1     0 ms          1 rows  SELECT item_id, what FROM plain_summaries WHERE kind = 'bill' AND item_id IN (?,?,?,?,?,?,?,?,?,?)

=== /reps/: 221 ms, HTTP 200, 31235 bytes, 3 queries, 1218 rows read
   105 ms  d1     2 ms        205 rows  SELECT o.slug, o.name, o.office, o.district, o.party, o.state, o.chamber FROM officials o WHERE o.active = 1 A
   103 ms  d1    16 ms        958 rows  SELECT o.slug, o.name, o.office, o.district, o.party, o.state, o.chamber FROM officials o WHERE o.active = 1 A
    87 ms  d1     1 ms         55 rows  SELECT * FROM officials WHERE chamber = ? AND active = 1 ORDER BY rank, name

=== /laws/: 218 ms, HTTP 200, 20836 bytes, 2 queries, 80 rows read
   125 ms  d1     1 ms         25 rows  SELECT a.bill_id, a.clauses FROM bill_analyses a WHERE a.current = 1 AND (a.status = 'reviewed' OR (a.status =
    81 ms  d1     9 ms         55 rows  SELECT * FROM bill_list WHERE 1 = 1 AND last_final IS NOT NULL ORDER BY last_final DESC, bill_id DESC LIMIT ? 

=== /votes/: 369 ms, HTTP 200, 22636 bytes, 2 queries, 310342 rows read
   257 ms  d1   168 ms     310313 rows  SELECT v.*, b.bill_number, b.title AS bill_title FROM votes v LEFT JOIN bills b ON b.id = v.bill_id WHERE v.vo
   108 ms  d1     0 ms         29 rows  SELECT a.bill_id, a.clauses FROM bill_analyses a WHERE a.current = 1 AND (a.status = 'reviewed' OR (a.status =

=== /topics/: 87 ms, HTTP 200, 13588 bytes, 1 queries, 7664 rows read
    81 ms  d1    16 ms       7664 rows  SELECT topic, COUNT(*) AS n FROM topic_tags WHERE removed_at IS NULL GROUP BY topic

=== /trades/: 87 ms, HTTP 200, 22415 bytes, 1 queries, 179 rows read
    82 ms  d1     7 ms        179 rows  SELECT t.*, r.report_url, r.transcribed_by, r.transcribed_at, o.name AS member_name, o.slug AS member_slug FRO

=== /explore/: 67 ms, HTTP 200, 14771 bytes, 1 queries, 3 rows read
    63 ms  d1     0 ms          3 rows  SELECT county_fips, COUNT(*) AS n FROM waitlist GROUP BY county_fips

=== /calaveras/: 2416 ms, HTTP 200, 12933 bytes, 5 queries, 149256 rows read
  2174 ms  d1  2096 ms     148924 rows  SELECT v.*, b.bill_number, b.title AS bill_title FROM votes v LEFT JOIN bills b ON b.id = v.bill_id WHERE v.id
    95 ms  d1     0 ms          1 rows  SELECT value FROM sync_state WHERE key = 'home_districts'
    74 ms  d1     1 ms          1 rows  SELECT * FROM meetings WHERE starts_at >= ? AND starts_at <= ? AND (? IS NULL OR level = ?) ORDER BY starts_at
    71 ms  d1     3 ms         83 rows  SELECT p.vote_id, p.position, p.raw_position, o.name, o.slug, o.office, o.district FROM all_positions p JOIN o
    66 ms  d1     4 ms        247 rows  SELECT o.*, s.vote_count AS vote_count FROM officials o LEFT JOIN official_stats s ON s.official_id = o.id WHE
section "place votes" failed: SectionTimeout: took longer than 3000 ms

=== /place/ca/santa-clara/: 3564 ms, HTTP 200, 65614 bytes, 6 queries, 250 rows read
   165 ms  d1     1 ms         55 rows  SELECT * FROM officials WHERE chamber = ? AND active = 1 ORDER BY rank, name
   110 ms  d1     1 ms         17 rows  SELECT * FROM officials WHERE chamber = ? AND active = 1 ORDER BY rank, name
    72 ms  d1     1 ms         53 rows  SELECT o.* FROM officials o WHERE o.active = 1 AND o.chamber = 'us-house' AND o.state = ? AND o.district_code 
    70 ms  d1     0 ms          3 rows  SELECT o.* FROM officials o WHERE o.active = 1 AND o.chamber = 'us-senate' AND o.state = ?
    69 ms  d1     1 ms         41 rows  SELECT o.* FROM officials o WHERE o.active = 1 AND o.chamber = ? AND o.district_code IN (?,?,?)
    65 ms  d1     1 ms         81 rows  SELECT o.* FROM officials o WHERE o.active = 1 AND o.chamber = ? AND o.district_code IN (?,?,?,?,?,?)

=== /ballot/ca/: 2122 ms, HTTP 200, 62099 bytes, 3 queries, 189144 rows read
  5090 ms  d1  5026 ms     188548 rows  SELECT v.*, b.bill_number, b.title AS bill_title FROM votes v LEFT JOIN bills b ON b.id = v.bill_id WHERE v.id
  2106 ms  d1     2 ms        271 rows  SELECT slug, name, last_name, office, district, district_code, level, chamber, active, state, senate_class FRO
  2088 ms  d1     5 ms        325 rows  SELECT f.candidate_id, o.slug, o.name, o.office, o.district, o.active, o.level FROM fec_candidates f JOIN offi

=== /elections/2026-11-03/: 11 ms, HTTP 200, 69263 bytes, 0 queries, 0 rows read

=== /bodies/us-senate/: 4 ms, HTTP 200, 10971 bytes, 0 queries, 0 rows read

=== /bodies/us-house/: 0 ms, HTTP 200, 11044 bytes, 0 queries, 0 rows read

=== /court/term/: 6 ms, HTTP 200, 60690 bytes, 0 queries, 0 rows read
