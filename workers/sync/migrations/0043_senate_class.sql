-- Which of a state's two U.S. Senate seats each senator holds (class 1, 2 or 3;
-- class 2 is up in 2026, 3 in 2028, 1 in 2030), from congress-legislators'
-- legislators-current.json (the `senate-classes` step, weekly). Race pages use it
-- to name the current holder of the seat that's up ("Open seat: the current
-- officeholder, [Name], isn't running for this seat."). NULL until read, and for
-- everyone who isn't a senator.
ALTER TABLE officials ADD COLUMN senate_class INTEGER CHECK (senate_class IN (1, 2, 3));
