-- Outside spenders' donors are read again (October 2026): the first reads
-- asked the FEC only for receipts it marks as not from individuals, which
-- left out companies' and nonprofits' gifts filed on the individual line
-- (11AI). Clearing the reads makes the dark-money step read every spender
-- again with both kinds of rows. Dark money stays off the pages meanwhile.
DELETE FROM outside_donors;
DELETE FROM outside_donor_reads;
