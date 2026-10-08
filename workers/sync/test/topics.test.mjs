// node workers/sync/test/topics.test.mjs
// Topics: the list and the industry table, the AI answer's checks, what gets
// tagged next and how it's saved, corrections from the review page (history
// kept, item locked), and a county's topic page with everything side by side.
// Runs the real migrations in an in-memory SQLite database. Every name here is invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { TOPICS, TOPIC, INDUSTRY_TOPICS, industriesFor } from "../src/topics/list.js";
import { cleanTags, topicMessage, topicSchema, TOPIC_INSTRUCTIONS } from "../src/topics/tag.js";
import { nextItems, saveTags } from "../src/topics/store.js";
import { INDUSTRIES } from "../src/funding/industry.js";
import { checkCorrection, itemFromLink, topicReviewChange, topicReviewItem } from "../../../functions/_lib/topic-review.js";
import { tagsFor, topicChips } from "../../../functions/_lib/topics.js";
import { placeTopicPage, topicPage } from "../../../functions/_lib/topic-pages.js";

const MIGRATIONS = new URL("../migrations/", import.meta.url);
const SRC = "https://example.org/source";

function d1(sqlite) {
  const stmt = (sql, binds = []) => ({
    bind: (...b) => stmt(sql, b),
    all: async () => ({ results: sqlite.prepare(sql).all(...binds) }),
    first: async () => sqlite.prepare(sql).get(...binds) ?? null,
    run: async () => sqlite.prepare(sql).run(...binds),
  });
  return {
    prepare: (sql) => stmt(sql),
    batch: async (list) => {
      sqlite.exec("BEGIN");
      try {
        for (const s of list) await s.run();
        sqlite.exec("COMMIT");
      } catch (err) {
        sqlite.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
  return { sqlite, db: d1(sqlite) };
}

test("the list: 15 to 20 topics with stable slugs, and an industry table that only names real industries and topics", () => {
  assert.ok(TOPICS.length >= 15 && TOPICS.length <= 20, `${TOPICS.length} topics`);
  for (const t of TOPICS) assert.match(t.slug, /^[a-z]+(-[a-z]+)*$/);
  for (const [industry, topics] of Object.entries(INDUSTRY_TOPICS)) {
    assert.ok(INDUSTRIES[industry], industry);
    for (const t of topics) assert.ok(TOPIC[t], t);
  }
  assert.deepEqual(industriesFor("agriculture"), ["agriculture"]);
  assert.deepEqual(industriesFor("water"), [], "no industry is tied to water");
  for (const t of TOPICS) assert.ok(TOPIC_INSTRUCTIONS.includes(`- ${t.slug}:`), `${t.slug} is in the instructions`);
});

test("the AI's answer: known topics only, at most three, no repeats; judging words in a reason are replaced", () => {
  const items = [{ kind: "bill", id: "b1", text: "A bill" }, { kind: "bill", id: "b2", text: "Another" }, { kind: "meeting_item", id: "m/1", text: "Roll call" }];
  assert.match(topicMessage(items), /^Items, as: id \| kind \| text\n\ni1 \| Bill \| A bill/);
  assert.deepEqual(topicSchema(["i1"]).properties.items.items.properties.id.enum, ["i1"]);
  const got = cleanTags(
    {
      items: [
        { id: "i1", topics: ["water", "water", "made-up", "wildfire", "housing", "health"], reason: "Funds reservoir repairs." },
        { id: "i2", topics: ["taxes-budget"], reason: "A reckless and extreme tax grab." },
        { id: "i3", topics: [], reason: "Procedure." },
        { id: "i1", topics: ["energy"], reason: "duplicate answer" },
        { id: "i9", topics: ["energy"], reason: "not asked" },
      ],
    },
    items
  );
  assert.deepEqual(got.map((g) => [g.item.id, g.topics]), [["b1", ["water", "wildfire", "housing"]], ["b2", ["taxes-budget"]], ["m/1", []]]);
  assert.equal(got[1].reason, "About taxes and budget.");
});

function seed(sqlite) {
  const off = sqlite.prepare("INSERT INTO officials (id, slug, name, office, level, chamber, body, source_url, last_verified, active, state, district_code, rank) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-01-01', 1, 'CA', ?, ?)");
  off.run("s1", "sam-ridge", "Sam Ridge", "U.S. Senator", "federal", "us-senate", "us-senate", SRC, null, null);
  off.run("h5", "hal-brook", "Hal Brook", "U.S. Representative", "federal", "us-house", "us-house", SRC, "5", null);
  off.run("h9", "far-away", "Far Away", "U.S. Representative", "federal", "us-house", "us-house", SRC, "9", null);
  off.run("ss4", "sue-stone", "Sue Stone", "State Senator", "state", "ca-senate", "ca-senate", SRC, "4", null);
  off.run("a8", "al-vale", "Al Vale", "Assemblymember", "state", "ca-assembly", "ca-assembly", SRC, "8", null);
  off.run("gov", "gia-glen", "Gia Glen", "Governor", "state", "ca-executive", "ca-executive", SRC, null, 1);
  off.run("sup1", "sid-pine", "Sid Pine", "Supervisor, District 1", "county", "county-board", "board-of-supervisors", SRC, "1", null);
  const bill = sqlite.prepare("INSERT INTO bills (id, level, chamber, bill_number, session, title, source_url) VALUES (?, ?, ?, ?, ?, ?, ?)");
  bill.run("us-119-hr-1", "federal", "us-house", "H.R. 1", "119", "Reservoir Repair Act", SRC);
  bill.run("ca-20252026-sb-2", "state", "ca-senate", "SB 2", "20252026", "Groundwater basins", SRC);
  bill.run("us-119-hres-3", "federal", "us-house", "H.Res. 3", "119", "Honoring a team", SRC);
  const vote = sqlite.prepare("INSERT INTO votes (id, bill_id, level, chamber, vote_date, question, vote_type, result, source_url) VALUES (?, ?, ?, ?, ?, 'On Passage', 'final_passage', 'Passed', ?)");
  vote.run("fv1", "us-119-hr-1", "federal", "us-house", "2026-05-01", SRC);
  vote.run("fv2", "ca-20252026-sb-2", "state", "ca-senate", "2026-06-01", SRC);
  const pos = sqlite.prepare("INSERT INTO vote_positions (vote_id, official_id, position, raw_position) VALUES (?, ?, ?, ?)");
  pos.run("fv1", "h5", "Yes", "Yea");
  pos.run("fv1", "s1", "No", "Nay");
  pos.run("fv1", "h9", "Yes", "Yea");
  pos.run("fv2", "ss4", "Yes", "Aye");
  const bl = sqlite.prepare("INSERT INTO bill_list (bill_id, level, chamber, bill_number, title, session, last_vote, vote_count, last_final, final_count, final_vote_id, final_result, yea, nay, routine) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?, 'Passed', 2, 1, ?)");
  bl.run("us-119-hr-1", "federal", "us-house", "H.R. 1", "Reservoir Repair Act", "119", "2026-05-01", "2026-05-01", "fv1", 0);
  bl.run("ca-20252026-sb-2", "state", "ca-senate", "SB 2", "Groundwater basins", "20252026", "2026-06-01", "2026-06-01", "fv2", 0);
  bl.run("us-119-hres-3", "federal", "us-house", "H.Res. 3", "Honoring a team", "119", "2026-06-02", null, null, 1);
  const meet = sqlite.prepare("INSERT INTO meetings (id, level, source, body, starts_at, source_url) VALUES (?, 'county', 'tylermm', 'Board of Supervisors', ?, ?)");
  meet.run("tm-1", "2099-01-05T09:00", SRC);
  meet.run("tm-0", "2020-01-05T09:00", SRC);
  const item = sqlite.prepare("INSERT INTO meeting_items (meeting_id, item_key, number, title, sort) VALUES (?, ?, ?, ?, ?)");
  item.run("tm-1", "5", "5", "Approve a water tank contract", 1);
  item.run("tm-0", "3", "3", "Adopt the groundwater plan", 1);
  item.run("tm-1", "1", "1", "Pledge of Allegiance", 0);
  sqlite.prepare("INSERT INTO executive_actions (id, official_id, kind, number, title, signed_on, source_url) VALUES ('ca-gov:1', 'gov', 'executive_order', 'N-1-26', 'Order on drought response', '2026-04-01', ?)").run(SRC);
  sqlite.prepare("INSERT INTO promise_pages (url, official_id, kind, title, added_by, excerpt, excerpt_at, excerpt_by) VALUES ('https://example.org/ss4/issues', 'ss4', 'campaign_site', 'Issues', 'test', 'I will work to store more water for dry years.', '2026-09-01', 'model')").run();
  sqlite.prepare("INSERT INTO funding_pacs (official_id, cycle, committee_id, name, total, count, industry, source_url) VALUES ('h5', 2026, 'C1', 'Growers PAC', 1000, 2, 'agriculture', ?)").run(SRC);
  sqlite.prepare("INSERT INTO state_money_cycles (official_id, cycle, raised, spent, source_url) VALUES ('a8', '2025-2026', 5000, 100, ?)").run(SRC);
  sqlite.prepare("INSERT INTO state_money_industries (official_id, cycle, industry, total) VALUES ('a8', '2025-2026', 'agriculture', 500)").run();
}

test("what's tagged next: agenda items first, then excerpts, executive actions and bills; never a routine bill; an excerpt again when it changes", async () => {
  const { sqlite, db } = freshDb();
  seed(sqlite);
  const first = await nextItems(db, 20);
  assert.deepEqual(first.map((i) => i.kind), ["meeting_item", "meeting_item", "meeting_item", "platform", "executive_action", "bill", "bill"]);
  assert.ok(!first.some((i) => i.id === "us-119-hres-3"), "the routine bill isn't sent");
  assert.ok(first.find((i) => i.id === "tm-1/5").text.includes("Approve a water tank contract"));
  const asAnswered = first.map((item) => ({ item, topics: item.id === "tm-1/1" ? [] : ["water"], reason: "About water." }));
  asAnswered.find((r) => r.item.id === "us-119-hr-1").topics = ["water", "agriculture"];
  await saveTags(db, asAnswered, "test-model");
  assert.deepEqual(await nextItems(db, 20), [], "nothing is sent twice");
  const tags = await tagsFor(db, "bill", ["us-119-hr-1"]);
  assert.deepEqual(tags.get("us-119-hr-1").map((t) => t.topic), ["water", "agriculture"]);
  sqlite.prepare("UPDATE promise_pages SET excerpt = 'I will widen rural roads.'").run();
  const again = await nextItems(db, 20);
  assert.deepEqual(again.map((i) => [i.kind, i.retag]), [["platform", true]]);
  await saveTags(db, [{ item: again[0], topics: ["roads-transportation"], reason: "About roads." }], "test-model");
  const live = await tagsFor(db, "platform", ["https://example.org/ss4/issues"]);
  assert.deepEqual(live.get("https://example.org/ss4/issues").map((t) => t.topic), ["roads-transportation"]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM topic_tags WHERE item_kind = 'platform' AND removed_at IS NOT NULL").get().n, 1, "the old tag is kept, marked removed");
  return { sqlite, db };
});

test("corrections: checked, history kept, the person's name shown, and the item locked against re-tagging", async () => {
  assert.match(checkCorrection({ topics: ["water", "wildfire", "housing", "health"], note: "x", reviewer: "Pat" }).error, /at most 3/);
  assert.match(checkCorrection({ topics: ["nope"], note: "x", reviewer: "Pat" }).error, /from the list/);
  assert.match(checkCorrection({ topics: [], note: "", reviewer: "Pat" }).error, /why/);
  assert.match(checkCorrection({ topics: ["water"], note: "A disastrous plan.", reviewer: "Pat" }).error, /neutral/);
  assert.equal(checkCorrection({ topics: [], note: "Only the pledge.", reviewer: "Pat" }).error, "", "no topic is allowed");
  assert.deepEqual(itemFromLink("https://thepillory.co/laws/bills/us-119-hr-1/"), { kind: "bill", id: "us-119-hr-1" });
  assert.deepEqual(itemFromLink("https://thepillory.co/meetings/tm-1/#item-5"), { kind: "meeting_item", id: "tm-1/5" });
  assert.deepEqual(itemFromLink("ca-20252026-sb-2"), { kind: "bill", id: "ca-20252026-sb-2" });
  assert.equal(itemFromLink("hello"), null);

  const { sqlite, db } = freshDb();
  seed(sqlite);
  const items = await nextItems(db, 20);
  await saveTags(db, items.map((item) => ({ item, topics: ["water", "environment"], reason: "About water." })), "test-model");
  const r = await topicReviewChange(db, "bill", "us-119-hr-1", { topics: ["water", "agriculture"], note: "Repairs irrigation reservoirs.", reviewer: "Pat Reyes" });
  assert.match(r.done, /Water, Agriculture/);
  const live = (await tagsFor(db, "bill", ["us-119-hr-1"])).get("us-119-hr-1");
  assert.deepEqual(live.map((t) => [t.topic, t.tagged_by]).sort(), [["agriculture", "person:Pat Reyes"], ["water", "person:Pat Reyes"]]);
  const removed = sqlite.prepare("SELECT topic, removed_by, removed_note FROM topic_tags WHERE item_id = 'us-119-hr-1' AND removed_at IS NOT NULL ORDER BY topic").all();
  assert.deepEqual(removed.map((x) => [x.topic, x.removed_by]), [["environment", "person:Pat Reyes"], ["water", "person:Pat Reyes"]]);
  assert.equal(sqlite.prepare("SELECT locked_by FROM topic_runs WHERE item_id = 'us-119-hr-1'").get().locked_by, "Pat Reyes");
  const page = await topicReviewItem(db, { REVIEWER_NAME: "" }, "bill", "us-119-hr-1");
  assert.match(page.main, /corrected by Pat Reyes/);
  assert.match(page.main, /History/);
  // A locked excerpt isn't re-tagged even when its text changes.
  await topicReviewChange(db, "platform", "https://example.org/ss4/issues", { topics: ["water"], note: "About water storage.", reviewer: "Pat Reyes" });
  sqlite.prepare("UPDATE promise_pages SET excerpt = 'Something new.'").run();
  assert.deepEqual(await nextItems(db, 20), []);
});

test("chips link to the topic's page, for a place when given", () => {
  const html = topicChips([{ topic: "water" }, { topic: "wildfire" }], { st: "CA", slug: "calaveras" });
  assert.match(html, /href="\/place\/ca\/calaveras\/topics\/water\/"/);
  assert.match(topicChips([{ topic: "water" }]), /href="\/topics\/water\/"/);
  assert.equal(topicChips([]), "");
});

test("a county's topic page: bills with its reps' positions, meetings, executive actions, own words and money, side by side", async () => {
  const { sqlite, db } = freshDb();
  seed(sqlite);
  const items = await nextItems(db, 20);
  await saveTags(db, items.map((item) => ({ item, topics: item.id === "tm-1/1" ? [] : item.kind === "bill" ? ["water", "agriculture"] : ["water"], reason: "About water." })), "test-model");
  const place = { st: "CA", name: "California", chambers: { sldu: "State Senate", sldl: "State Assembly" } };
  const c = { fips: "06009", slug: "calaveras", name: "Calaveras County", cd: [["5", 1]], sldu: [["4", 1]], sldl: [["8", 1]], neighbors: [] };
  const html = await (await placeTopicPage({ DB: db }, place, c, "water")).text();
  for (const s of ["Water in Calaveras County", "Reservoir Repair Act", "Groundwater basins", "Approve a water tank contract", "Adopt the groundwater plan", "Order on drought response", "I will work to store more water for dry years.", "nothing here says that one caused another"]) assert.ok(html.includes(s), s);
  assert.ok(html.includes("Hal Brook") && html.includes("Sam Ridge") && html.includes("Sue Stone"), "this county's reps and their positions");
  assert.ok(!html.includes("Far Away"), "another district's rep isn't listed");
  assert.ok(!html.includes("Pledge of Allegiance"), "an item with no topic isn't listed");
  assert.match(html, /No campaign-funding industry is tied to water/);
  const ag = await (await placeTopicPage({ DB: db }, place, c, "agriculture")).text();
  assert.ok(ag.includes("$1,000") && ag.includes("Federal Election Commission"), "FEC money from the agriculture industry");
  assert.ok(ag.includes("$500") && ag.includes("Cal-Access"), "Cal-Access money from the agriculture industry");
  assert.doesNotMatch(ag, /because|bought|paid for|influence/i, "no causal wording");
  assert.equal((await placeTopicPage({ DB: db }, place, c, "nope")).status, 404);
  const general = await (await topicPage({ DB: db }, "water")).text();
  assert.ok(general.includes("Reservoir Repair Act") && general.includes("Water in Calaveras County"));
});
