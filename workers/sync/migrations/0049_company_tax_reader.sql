-- Taxes paid by place, read again with every member of the 10-K's breakdown
-- (tools/build_company_taxes.py, READER): "other states", "other countries" and
-- company-defined members, and the federal / state / foreign totals filed on the
-- same axis. A filing read by an older reader is read again once.
ALTER TABLE company_tax_filings ADD COLUMN reader INTEGER NOT NULL DEFAULT 1;
