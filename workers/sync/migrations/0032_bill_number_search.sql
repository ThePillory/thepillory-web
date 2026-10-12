-- The global search finds a bill by its number as typed ("hr 1234", "H.R.1234",
-- "AB 5"): an index on the number without dots or spaces, lowercased, so the
-- lookup reads only the matching rows. functions/_lib/people-search.js uses the
-- same expression (numberKey()).
CREATE INDEX IF NOT EXISTS bill_list_number_key ON bill_list (lower(replace(replace(bill_number, '.', ''), ' ', '')));
