// FAKE Tyler Meeting Manager responses for tests. The JSON fields and the agenda
// PDF layouts copy the county's real ones (Board of Supervisors: a short agenda
// with "." section headings, "Title, Department." item heads, and an
// "Attachments" list, plus a separate item-number column; Planning Commission:
// only the packet, whose first pages are the agenda), but every name, item and
// number is invented. Dates are relative to today.
import { dayFromToday } from "./iqm2-fixtures.mjs";

const ymd = (d) => d.toISOString().slice(0, 10);
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Same days as some IQM2 fixtures: day 2 (IQM2 9001 has items, so the IQM2 copy
// stays) and day 9 (IQM2 9004 has none, so it's replaced).
export const TMM_MEETINGS = [
  { meetingId: 501, type: 5, day: 2, agendaId: 8100, posted: true, titles: ["Resolution - 2099-0100"] },
  { meetingId: 502, type: 5, day: 3, agendaId: 8101, posted: true, special: true,
    titles: [
      "Pursuant to Govt. Code § 54957.6, conference with County-designated labor negotiators [Negotiator A] and [Negotiator B] regarding the following employee organizations: [Employee Union A]; [Employee Union B].",
      "Proclamation - 2099-0101",
      "Minutes of Board of Supervisors – Regular Meeting – January 6, 2099 9:00 AM",
      "Resolution - 2099-0102",
      "Agreement-2099-0103",
      "Ordinance - 2099-0104",
    ] },
  { meetingId: 601, type: 11, day: 5, agendaId: 8102, posted: true, titles: [] },
  { meetingId: 602, type: 11, day: 8, title: "Cancelled - Planning Commission", agendaId: 0, posted: false, titles: [], longDate: true },
  { meetingId: 503, type: 5, day: 9, agendaId: 8103, posted: false, titles: [] },
  { meetingId: 504, type: 5, day: 16, agendaId: 0, posted: false, titles: [], longDate: true },
  // A committee we don't follow.
  { meetingId: 701, type: 4, day: 4, agendaId: 0, posted: false, titles: [] },
];

function record(m) {
  const d = dayFromToday(m.day);
  const body = { 5: "Board of Supervisors", 11: "Planning Commission", 4: "Strategic Planning and Financing Committee" }[m.type];
  return {
    id: `fake${m.meetingId}`,
    meetingId: m.meetingId,
    recurringId: m.meetingId,
    meetingTypeId: m.type,
    meetingAgendaId: m.agendaId,
    agendaStatus: m.posted ? 5 : 0,
    startDateTime: `${ymd(d)}T04:00:00.000+00:00`,
    startTime: "9:00 AM",
    meetingTitle: m.title || body,
    location: "This meeting will be held in the Board of Supervisors Chambers [Street address], San Andreas, CA 95249.",
    // The real API gives this in two formats.
    actualStartDate: m.longDate ? `${WD[d.getUTCDay()]} ${MON[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, "0")} 00:00:00 EDT ${d.getUTCFullYear()}` : `${ymd(d)} 00:00:00.0`,
    agendaPostedDate: m.posted ? `${ymd(dayFromToday(m.day - 7))}T17:00:00.000+00:00` : null,
    agendaPacketDocumentId: m.posted ? `DOC${m.agendaId}P` : "",
    agendaSummaryDocumentId: m.posted && m.type === 5 ? `DOC${m.agendaId}S` : "",
    videoId: m.day < 0 ? "abcdEFGH123" : "",
    videoStatus: m.day < 0 ? "public" : "",
    canceled: false,
    description: m.special ? "Special Meeting" : "Regular Meeting",
    meetingTypeName: body,
    agendaItemTitles: m.titles,
    agendaItemDescriptions: m.titles.map(() => "<div>not aligned with the titles in the real API</div>"),
    base64ThumbnailsString: "AAAA",
  };
}

/** The list response for meetingTypeIds; dates must be MM/DD/YYYY, as the real API requires. */
export function meetingList(body) {
  const ok = /^\d{2}\/\d{2}\/\d{4}$/;
  if (!ok.test(body.startDate || "") || !ok.test(body.endDate || "")) return null;
  const types = body.meetingTypeIds || [];
  return TMM_MEETINGS.filter((m) => types.includes(m.type)).map(record);
}

const BOS_HEADER = [
  "1 of 3",
  "CALAVERAS COUNTY BOARD OF SUPERVISORS",
  "[SUPERVISOR, DISTRICT 1]",
  "SPECIAL MEETING",
  "This meeting will be held in the Board of Supervisors Chambers.",
  "This Board of Supervisors meeting is open to the public. Members of the public may observe the meeting",
  "remotely via Zoom, and may comment via Zoom, using the instructions below.",
  "As an alternative to commenting in person or via Zoom, you can make a public",
  "comment by e-mailing the Clerk of the Board, clerk@example.org, no later than 4:00 pm on the day before the Board meeting.",
  "Please clearly indicate which agenda item number your comment pertains to.",
  "In Compliance with the Americans with Disabilities Act (ADA), please contact the Clerk at least 48 hours prior to the start of the meeting.",
];

/** Agenda PDF pages (lines), by agenda id and form (packet or not). Null: not found. */
export function agendaPages(agendaId, packet) {
  const id = Number(agendaId);
  if (id === 8100 && !packet) return [BOS_HEADER, ["2 of 2", ".Consent Agenda", "Resolution - 2099-0100, Auditor.", "Adopt a Resolution about [a fake topic]."]];
  if (id === 8101 && !packet)
    return [
      BOS_HEADER,
      [
        "2 of 3",
        "1.",
        "2.",
        "1.",
        ".9:00 AM Call to Order",
        "To view or give public comment virtually, register in advance:",
        "https://us02web.zoom.us/webinar/register/WN_fakeTest123",
        ".Closed Session",
        "Pursuant to Govt. Code § 54957.6, conference with County-designated labor negotiators [Negotiator A].",
        "and [Negotiator B] regarding the following employee organizations: [Employee Union A];",
        "[Employee Union B].",
        ".Recognition & Acknowledgements",
        "Proclamation - 2099-0101, Clerk of the Board.",
        "Adopt a Proclamation recognizing [a fake observance].",
        "Attachments",
        "Staff Memo_Fake.docx",
        "Proclamation_Fake.docx",
        ".Consent Agenda",
        "Consent agenda items are expected to be routine and non-controversial.",
        "Minutes of Board of Supervisors – Regular Meeting – January 6, 2099 9:00 AM, Clerk of the Board.",
      ],
      [
        "3 of 3",
        "3.",
        "4.",
        "1.",
        "Attachments",
        "Minutes_20990106.pdf",
        "Resolution - 2099-0102, Public Works.",
        "Adopt a Resolution approving [a fake road project] in an amount not to exceed $100.",
        "Attachments",
        "Staff Memo_Road.docx",
        "Agreement-2099-0103, Library.",
        "Authorize the Board Chair to sign an agreement with [Vendor A].",
        ".Regular Agenda",
        "Ordinance - 2099-0104, Planning.",
        "Conduct a Public Hearing and introduce an ordinance about [a fake land use].",
        "Attachments",
        "Staff Memo_Ordinance.docx",
        "Draft Ordinance.pdf",
        ".Adjournment",
      ],
    ];
  if (id === 8102 && packet)
    return [
      [
        "1",
        "CALAVERAS COUNTY PLANNING COMMISSION",
        "REGULAR MEETING AGENDA",
        "This Planning Commission meeting is open to the public.",
        "You may also comment on a specific agenda item prior to the hearing via email. To do so, submit",
        "your comment via email to the Clerk of the Planning Commission at",
        "https://example.org/Feedback/Planning-Commission-Clerk no later than 4:00pm on the Monday",
        "prior to the Commission meeting. Please clearly indicate which agenda item number your comment",
        "pertains to. Comments are limited to 300 words or less.",
      ],
      [
        "2",
        "9:00 AM CALL TO ORDER",
        "To view or give public comment virtually, register in advance:",
        "https://us06web.zoom.us/meeting/register/fakePC456",
        "PLEDGE OF ALLEGIANCE",
        "GENERAL PUBLIC COMMENT PERIOD",
        "Any land use item of interest to the public may be addressed during the Public Comment period.",
        "CONSENT AGENDA",
        "None",
        "REGULAR AGENDA",
        "1. 2099-001 Tentative Parcel Map for [Applicant A] The applicant is requesting approval",
        "to divide one parcel into two lots. The project site (APN 000-000-000) is located in",
        "Section 1, T01N, R01E, MDM&B. ([Planner], Planner)",
        "2. 2099-002 Conditional Use Permit for [Applicant B] to operate [a fake use].",
      ],
      ["3", "INFORMATIONAL ITEMS - None", "COMMISSIONER REPORTS", "ADJOURNMENT"],
      ["CALAVERAS COUNTY PLANNING DEPARTMENT", "Planning Commission Staff Report", "1. This numbered line is in a staff report and is not an agenda item."],
    ];
  return null;
}
