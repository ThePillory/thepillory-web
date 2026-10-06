// Promises a person adds by hand on /admin/review/promise/new/ (a quote from
// a meeting video, an interview, a page the AI doesn't read), and the
// campaign and office "Issues" or "Priorities" pages the sync reads. Pure
// checks, tested in workers/sync/test/promises.test.mjs; the routes are in
// functions/admin/[[path]].js.
//
// A person's entry is approved as they save it (their name is shown with it),
// so the same rules as an AI suggestion apply in code first: the quote is a
// commitment (or the person confirms it is), the note is neutral, a deadline
// only when the quote states it, and every source is an http(s) link.
import { safeUrl } from "./render.js";
import { SOURCE_KIND, timeSeconds } from "./promises.js";
import { normalizeText, notACommitment, wordingProblems } from "../../workers/sync/src/promises/check.js";

export const ENTRY_KINDS = Object.keys(SOURCE_KIND);
export const PAGE_KINDS = { campaign_site: "Campaign website", office_site: "Office website" };
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const clean = (v, max) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);

/** How an official is shown (and typed) in the picker: "Name · Office". */
export const officialLabel = (o) => `${o.name} · ${o.office}`;

/** The official a typed label names, or null. */
export function findOfficial(officials, label) {
  const want = clean(label, 300).toLowerCase();
  return officials.find((o) => officialLabel(o).toLowerCase() === want) || null;
}

/**
 * Check a hand-entered promise. Returns { error, needsConfirm, row }: row is
 * ready to insert when error is empty. `today` is an ISO date.
 */
export function checkEntry(form, officials, today) {
  const f = {
    official: clean(form.official, 300),
    quote: normalizeText(form.quote).slice(0, 1000),
    made_on: clean(form.made_on, 10),
    source_url: clean(form.source_url, 2000),
    source_title: clean(form.source_title, 300),
    source_kind: clean(form.source_kind, 40),
    source_time: clean(form.source_time, 8),
    check_note: clean(form.check_note, 400),
    due: clean(form.due, 100),
    reviewer: clean(form.reviewer, 80),
    confirm: form.confirm === "yes" || form.confirm === true,
  };
  const o = findOfficial(officials, f.official);
  const why = f.quote ? notACommitment(f.quote) : null;
  const words = wordingProblems(f.check_note, { strict: false });
  const error = !o ? "Choose the official from the list (name · office)."
    : f.quote.length < 20 ? "Paste the quote, word for word (at least a full clause)."
    : f.quote.length > 600 ? "Keep the quote to the one sentence or clause that states the commitment."
    : !ISO_DATE.test(f.made_on) || f.made_on > today ? "Enter the date it was said or published (not in the future)."
    : !safeUrl(f.source_url) ? "Enter the source as an http(s) link."
    : !f.source_title ? "Give the source a title, as the source names itself (for example the meeting and its date)."
    : !SOURCE_KIND[f.source_kind] ? "Choose what kind of source it is."
    : f.source_time && timeSeconds(f.source_time) == null ? "Enter the time in the video as h:mm:ss or m:ss, or leave it empty."
    : !f.check_note ? "Say what would show it done."
    : f.check_note.length > 300 ? "Keep the note under 300 characters."
    : words.length ? `Use neutral wording in the note: ${words.join("; ")}.`
    : f.due && !f.quote.toLowerCase().includes(f.due.toLowerCase()) ? "A deadline only when the quote states one: copy it as the quote has it, or leave it empty."
    : !f.reviewer ? "Enter your name: it's shown with the promise."
    : why && !f.confirm ? `This may not be a specific commitment (${why}). If it is one, tick "This is a specific commitment" and save again.`
    : "";
  return {
    error,
    needsConfirm: Boolean(why) && !f.confirm,
    form: f,
    row: error
      ? null
      : {
          official_id: o.id,
          quote: f.quote,
          made_on: f.made_on,
          source_url: f.source_url,
          source_title: f.source_title,
          source_kind: f.source_kind,
          source_time: f.source_time || null,
          check_note: f.check_note,
          due: f.due || null,
          reviewed_by: f.reviewer,
          suggested_by: `Added by ${f.reviewer}`,
        },
  };
}

/** Check an Issues or Priorities page to read. Returns { error, row }. */
export function checkPage(form, officials, addedBy) {
  const f = { official: clean(form.official, 300), url: clean(form.url, 2000), kind: clean(form.kind, 40), title: clean(form.title, 200) };
  const o = findOfficial(officials, f.official);
  const error = !o ? "Choose the official from the list (name · office)."
    : !safeUrl(f.url) ? "Enter the page as an http(s) link."
    : !PAGE_KINDS[f.kind] ? "Choose whether it's the campaign's or the office's website."
    : !f.title ? 'Give the page its title as the site shows it (for example "Issues" or "Priorities").'
    : "";
  return { error, form: f, row: error ? null : { url: f.url, official_id: o.id, kind: f.kind, title: f.title, added_by: clean(addedBy, 200) || "admin" } };
}

/** The ids ticked for "Approve selected": positive integers, at most 50. */
export function selectedIds(values) {
  return [...new Set((values || []).map((v) => parseInt(v, 10)).filter((n) => n > 0))].slice(0, 50);
}
