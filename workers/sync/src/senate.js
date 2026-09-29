// U.S. Senate roll call votes from the official XML on senate.gov.
//   Vote list: https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_{congress}_{session}.xml
//   One vote:  https://www.senate.gov/legislative/LIS/roll_call_votes/vote{congress}{session}/vote_{congress}_{session}_{00001}.xml
import { activeOfficials, upsertBill, saveVote, existingVoteIds } from "./db.js";
import { classifyFederal, normalizePosition } from "./classify.js";
import { federalBill, normalizeBillType } from "./congress.js";
import { currentCongress, congressSessions, xmlTag, xmlBlocks, parseLongDate, BudgetExhausted } from "./util.js";

const BASE = "https://www.senate.gov/legislative/LIS";

function voteUrls(env, congress, session, number) {
  const base = env.SENATE_BASE || BASE;
  const n = String(number).padStart(5, "0");
  const path = `roll_call_votes/vote${congress}${session}/vote_${congress}_${session}_${n}`;
  return { xml: `${base}/${path}.xml`, page: `${BASE}/${path}.htm` };
}

// Match our senators in a vote's member list: by the LIS ID once known,
// otherwise by state + last name (and remember the LIS ID for next time).
async function matchSenators(db, senators, memberBlocks) {
  const members = memberBlocks.map((b) => ({
    lis: xmlTag(b, "lis_member_id"),
    last: xmlTag(b, "last_name").toLowerCase(),
    state: xmlTag(b, "state"),
    cast: xmlTag(b, "vote_cast"),
  }));
  const positions = [];
  for (const s of senators) {
    let m = s.lis_id ? members.find((x) => x.lis === s.lis_id) : null;
    if (!m) {
      const candidates = members.filter((x) => x.state === "CA" && x.last === String(s.last_name || "").toLowerCase());
      if (candidates.length === 1) {
        m = candidates[0];
        if (m.lis) {
          await db.prepare("UPDATE officials SET lis_id = ? WHERE id = ?").bind(m.lis, s.id).run();
          s.lis_id = m.lis;
        }
      }
    }
    if (m) positions.push({ official_id: s.id, position: normalizePosition(m.cast), raw_position: m.cast });
  }
  return positions;
}

export async function syncSenateVotes(env, db, budget) {
  const senators = await activeOfficials(db, "us-senate");
  if (!senators.length) return { status: "skipped", message: "no U.S. Senators loaded yet" };
  const congress = currentCongress();
  const base = env.SENATE_BASE || BASE;
  let saved = 0;
  let pending = 0;
  try {
    for (const session of congressSessions(congress)) {
      const have = await existingVoteIds(db, `us-senate-${congress}-${session}-`);
      const menu = await budget.text(`${base}/roll_call_lists/vote_menu_${congress}_${session}.xml`, {}, `senate menu ${session}`);
      const numbers = xmlBlocks(menu, "vote")
        .map((b) => parseInt(xmlTag(b, "vote_number"), 10))
        .filter((n) => n && !have.has(`us-senate-${congress}-${session}-${n}`))
        .sort((a, b) => a - b);
      pending += numbers.length;
      for (const n of numbers) {
        const urls = voteUrls(env, congress, session, n);
        const xml = await budget.text(urls.xml, {}, `senate vote ${n}`);
        const docType = normalizeBillType(xmlTag(xml, "document_type"));
        const docNumber = xmlTag(xml, "document_number");
        const docTitle = xmlTag(xml, "document_title") || xmlTag(xml, "vote_title");
        const question = xmlTag(xml, "question") || xmlTag(xml, "vote_question_text");
        const isNomination = docType === "PN" || /nomination/i.test(question);
        const isAmendment = !!xmlTag(xml, "amendment_number") && /amendment/i.test(question);
        const docCongress = parseInt(xmlTag(xml, "document_congress"), 10) || congress;
        const bill = isNomination ? null : federalBill(docCongress, docType, docNumber, docTitle);
        if (bill) await upsertBill(db, bill);
        const positions = await matchSenators(db, senators, xmlBlocks(xml, "member"));
        await saveVote(
          db,
          {
            id: `us-senate-${congress}-${session}-${n}`,
            bill_id: bill ? bill.id : null,
            subject: bill ? null : xmlTag(xml, "vote_document_text") || docTitle || null,
            level: "federal",
            chamber: "us-senate",
            vote_date: parseLongDate(xmlTag(xml, "vote_date")) || "",
            question: question || "(question not given by source)",
            vote_type: classifyFederal(question, { billTitle: docTitle, isNomination, isAmendment }),
            result: xmlTag(xml, "vote_result") || xmlTag(xml, "vote_result_text") || "Unknown",
            source_url: urls.page,
          },
          positions
        );
        saved += 1;
        pending -= 1;
      }
    }
    return { status: "ok", message: `Congress ${congress}: ${saved} new Senate vote(s) saved; caught up` };
  } catch (err) {
    if (err instanceof BudgetExhausted) {
      return { status: "partial", message: `Congress ${congress}: ${saved} new Senate vote(s) saved; ${pending} still to fetch. ${err.message}` };
    }
    throw err;
  }
}
