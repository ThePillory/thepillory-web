// Approximate industry categories for contributions, by keywords in a name.
//
// The FEC doesn't assign industries. This sorts a PAC's name (and its connected
// organization) or an employer's name into one of the categories below by fixed
// keyword rules, so totals by industry are approximate: names that match no rule
// stay "Not classified", and a rule can misfile an unusual name. The rules are the
// same for every official and every party. Pure; tested; shown on the methodology
// page. Lobbying organizations (src/funding/lobbying.js) use the same rules.

export const INDUSTRIES = {
  finance: "Finance, insurance and banking",
  real_estate: "Real estate",
  health: "Health care",
  pharma: "Pharmaceuticals and medical products",
  energy: "Energy and utilities",
  defense: "Defense and aerospace",
  tech: "Technology and telecommunications",
  agriculture: "Agriculture and food",
  transportation: "Transportation",
  construction: "Construction and engineering",
  legal: "Lawyers and lobbyists",
  labor: "Labor unions",
  education: "Education",
  government: "Government and public sector",
  retail: "Retail and consumer goods",
  manufacturing: "Manufacturing",
  media: "Media and entertainment",
  issue: "Issue and advocacy groups",
  leadership: "Other members' leadership PACs and campaigns",
  tribal: "Tribal governments",
  other: "Not classified",
};

// Order matters: the first rule that matches wins, so narrower rules come first
// (a "pharmaceutical" company isn't filed under health care; a teachers' union is labor).
const RULES = [
  ["tribal", /\b(tribes?|tribal|band of [\w ]*indians|indians|rancheria|pueblo|sovereign nation|nation of)\b/i],
  ["labor", /\b(union|unions|brotherhood|teamsters|afl-?cio|seiu|ufcw|ibew|afscme|uaw|united auto workers|workers of america|federation of teachers|education association|nea|operating engineers|laborers|ironworkers|carpenters|plumbers|pipefitters|electrical workers|machinists|firefighters|fire fighters|police|sheriffs?'? association|nurses association|letter carriers|postal workers|pilots association|air line pilots|steelworkers|boilermakers|painters|sheet metal|bricklayers|transport workers|longshore)\b/i],
  ["pharma", /\b(pharma\w*|biotech\w*|biogen|amgen|pfizer|merck|abbvie|eli lilly|lilly|johnson ?& ?johnson|bristol|novartis|sanofi|genentech|gilead|regeneron|medtronic|abbott|medical device|advamed|drug)\b/i],
  ["health", /\b(health\w*|hospital\w*|medical|medicine|physician\w*|doctors?|surgeons?|dental|dentists?|nurs(e|es|ing)|clinic\w*|kaiser|care ?(group|partners|centers?)|anesthesiolog\w*|radiolog\w*|cardiolog\w*|orthopa?edic\w*|optometr\w*|chiropract\w*|psychiatr\w*|unitedhealth|humana|cigna|anthem|elevance|centene|blue cross|blue shield)\b/i],
  ["finance", /\b(bank\w*|bancorp|financial|finance|capital|credit union|credit|insurance|insurers?|investment\w*|investors?|securities|asset management|equity|hedge|fund|funds|mutual|wells fargo|jpmorgan|goldman|morgan stanley|citigroup|citi|blackrock|vanguard|fidelity|charles schwab|visa|mastercard|american express|realtors? and bankers|accountants?|cpas?|deloitte|ernst|kpmg|pricewaterhouse|pwc|mortgage|lending|loans?)\b/i],
  ["real_estate", /\b(real ?estate|realt(y|ors?)|propert(y|ies)|homebuilders?|home builders|apartment|housing|land company|developers?|reit)\b/i],
  ["energy", /\b(oil|gas|petroleum|energy|electric|utilit(y|ies)|power|pipeline\w*|solar|wind|nuclear|coal|exxon\w*|chevron|conocophillips|marathon|valero|shell|bp|koch|edison|pg ?& ?e|sempra|duke energy|exelon|dominion|southern company|propane|refin\w*)\b/i],
  ["defense", /\b(defense|aerospace|lockheed|raytheon|rtx|northrop|boeing|general dynamics|l3harris|huntington ingalls|bae systems|leidos|saic|missile|military)\b/i],
  ["agriculture", /\b(farm\w*|agricultur\w*|ranch\w*|cattle\w*|dairy|growers?|crop\w*|grain|cotton|sugar|rice|wine\w*|vineyards?|food\w*|beverage\w*|restaurant\w*|meat|poultry|pork|beef|egg|nut|almond|walnut|citrus|produce|timber|forest\w*|lumber)\b/i],
  ["tech", /\b(technolog\w*|software|computer\w*|internet|tech|microsoft|google|alphabet|apple|amazon|meta|facebook|oracle|intel|ibm|cisco|qualcomm|nvidia|salesforce|telecom\w*|wireless|broadband|cable|comcast|verizon|at ?& ?t|t-mobile|charter|semiconductor\w*|data|cyber\w*|electronics?)\b/i],
  ["transportation", /\b(airlines?|airways|aviation|railroads?|railway|rail|trucking|truckers?|transport\w*|logistics|shipping|freight|fedex|ups|automobile|auto dealers?|automotive|car dealers?|motor|maritime)\b/i],
  ["construction", /\b(construction|contractors?|builders?|engineer\w*|architect\w*|cement|concrete|asphalt|paving|infrastructure)\b/i],
  ["legal", /\b(law|laws|lawyers?|attorneys?|legal|llp|trial lawyers|justice association|lobby\w*|government relations|public affairs|strategies)\b/i],
  ["education", /\b(universit(y|ies)|college\w*|school\w*|education\w*|academ(y|ic)|teachers?|student\w*)\b/i],
  ["government", /\b(county of|city of|state of|department of|u\.?s\.? (army|navy|air force|marine corps|government)|federal government|government|army|navy|air force|veterans affairs|public schools?|school district)\b/i],
  ["retail", /\b(retail\w*|stores?|walmart|target|costco|home depot|lowe'?s|grocer\w*|supermarkets?|consumer|apparel|tobacco|alcohol|beer|spirits|distill\w*|brewers?)\b/i],
  ["manufacturing", /\b(manufactur\w*|industr(y|ies|ial)|chemical\w*|steel|metals?|plastics?|paper|machinery|equipment|caterpillar|3m|general electric|honeywell|dow|dupont)\b/i],
  ["media", /\b(media|entertainment|broadcast\w*|television|tv|radio|film|motion picture|music|publishing|newspapers?|disney|netflix|warner|paramount|sports)\b/i],
  ["issue", /\b(conservative|progressive|liberal|freedom|liberty|values|action fund|action committee|leadership|victory|majority|future|america|americans|citizens|voters|women|veterans|pro-?life|choice|gun|rifle|second amendment|environment\w*|conservation|climate|sierra club|league|alliance|coalition|council|project|committee for|friends of)\b/i],
];

// Employers that aren't an industry: shown as their own line or left out.
export const NOT_EMPLOYED = /^(retired|not employed|unemployed|none|null|n\/?a|homemaker|self[- ]?employed|self|student|information requested|info requested|requested|refused|not provided|best efforts|disabled|not applicable|entrepreneur|investor|private|-)\b|^\W*$/i;

/**
 * A political committee's category: another member's leadership PAC or campaign
 * committee (FEC designation D, or committee type H, S or P) by its FEC record;
 * otherwise by keywords in its name.
 */
export function classifyCommittee({ name, designation, committee_type }) {
  if (designation === "D" || ["H", "S", "P"].includes(committee_type)) return "leadership";
  return classify(name);
}

/** The category key for a name (and optional connected organization). */
export function classify(...names) {
  const text = names.filter(Boolean).join(" | ");
  if (!text.trim()) return "other";
  for (const [key, re] of RULES) if (re.test(text)) return key;
  return "other";
}
