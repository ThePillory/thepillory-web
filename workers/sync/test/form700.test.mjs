// node --test test/form700.test.mjs
// California Form 700 lines on an official's More tab (functions/_lib/exec-funding.js):
// each investment acquired or disposed of, exactly as filed, from the statements read;
// a statement not read in full is a link. Every name here is invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { form700Lines, stateForm700 } from "../../../functions/_lib/exec-funding.js";

const f = {
  check: { checked_at: "2026-10-01 11:00:00", note: null },
  rows: [{ id: "fppc:AAAAAAAA-0000-0000-0000-000000000001", source: "fppc", doc_type: "Form 700, Annual", period: "2025", filed_on: "2026-03-01", position: "Treasurer", agency: "Treasurer" }],
  reads: [
    { disclosure_id: "fppc:AAAAAAAA-0000-0000-0000-000000000001", period: "2025", status: "read", entries: 40, lines: 2 },
    { disclosure_id: "fppc:AAAAAAAA-0000-0000-0000-000000000002", period: "2024", status: "link", reason: "page 3: 2 value boxes checked" },
  ],
  lines: [
    { disclosure_id: "fppc:AAAAAAAA-0000-0000-0000-000000000001", period: "2025", n: 1, entity: "Example Devices, Inc.", description: "Technology - Retirement Account - Spouse", nature: "Stock", value: "$2,000 - $10,000", acquired: null, disposed: "2025-10-21" },
    { disclosure_id: "fppc:AAAAAAAA-0000-0000-0000-000000000001", period: "2025", n: 2, entity: "Example Land, LLC", description: "Commercial land", nature: "Other: LLC", value: "$100,001 - $1,000,000", acquired: "2025-03-10", disposed: null },
  ],
};

test("Form 700 lines: as filed, with the value box, the date and the statement; unread statements as links", () => {
  const html = form700Lines(f);
  assert.match(html, /Bought and sold \(Schedule A-1\)/);
  assert.match(html, /<span class="cr-side">Disposed</);
  assert.match(html, /Example Devices, Inc\./);
  assert.match(html, /Value \$2,000 - \$10,000 · Oct 21, 2025 · Technology - Retirement Account - Spouse · 2025 statement/);
  assert.match(html, /Other: LLC[^<]*<\/span><\/span>\s*<span class="cr-side">Acquired</);
  assert.match(html, /2 of 40 investments acquired or disposed of/);
  assert.match(html, /2024 statement ↗<\/a>: not read in full/);
  assert.match(html, /not the size of a purchase or sale/);
  assert.match(html, /\/api\/form700\/AAAAAAAA-0000-0000-0000-000000000001/);
  assert.doesNotMatch(html, /conflict/i);
  // In the Disclosures section, before the list of statements.
  assert.match(stateForm700({ form700: f }), /Bought and sold[\s\S]*Statements/);
  // Nothing read yet: no section.
  assert.equal(form700Lines({ ...f, reads: [] }), "");
});
