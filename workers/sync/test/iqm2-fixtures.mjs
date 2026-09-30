// FAKE county meeting portal pages for tests. The markup copies the real IQM2
// portal's structure (calendar rows, the "RSS" page, the web agenda table) so
// the parsers are tested against it, but every name, item, and number is
// invented. Dates are relative to today so "this week" always has meetings.
// Like the real list, some rows hide their Agenda link (listed: false) even though
// the meeting's own page links the agenda.

const MONTHS = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];
const DAYS = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];

export function dayFromToday(n) {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

const tip = (d, time, board, type, status) =>
  `${DAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}  ${time}&#13;&#13;Board:&#09;${board}&#13;Type:&#09;${type}&#13;Status:&#09;${status}&#13;&#13;&#09;Board of Supervisors Chambers&#13;&#09;891 Mountain Ranch Road, San Andreas, CA  95249`;

const link = (href, label) =>
  href ? `<div>&nbsp;<a href='${href}' class='' target='_blank'>${label}</a>&nbsp;</div>` : `<div>&nbsp;<a href='' class='HiddenDocumentLink' target=''>${label}</a>&nbsp;</div>`;

function row(m) {
  const d = dayFromToday(m.day);
  return `
       <div class="Row MeetingRow" >
            <div class="RowTop">
                <div class="RowIcon"><a href="javascript:void(0);"><img class='MeetingIcon' src='images/MeetingIcon.gif' title="${tip(d, m.time, m.board, m.type, m.status)}" alt='info' /></a></div>
                <div class="RowLink"><a href="/Citizens/Detail_Meeting.aspx?ID=${m.id}" title="${tip(d, m.time, m.board, m.type, m.status)}" >${d.toDateString()}</a></div>
                ${m.status === "Cancelled" ? `<div class="RowRight"><span class='MeetingCancelled'>Cancelled</span></div>` : `
                <div class="RowRight MeetingLinks">
                    ${link(m.agenda && m.listed !== false ? `FileOpen.aspx?Type=14&ID=${m.agenda}&Inline=True` : "", "Agenda")}
                    ${link(m.agenda && m.listed !== false ? `FileOpen.aspx?Type=1&ID=${m.agenda}&Inline=True` : "", "Agenda Packet")}
                    ${link("", "Summary")}
                    ${link(m.minutes ? `FileOpen.aspx?Type=12&ID=${m.minutes}&Inline=True` : "", "Minutes")}
                    <div class="WithoutSeparator">&nbsp;<a href="#" id="lnkMeetingVideo" class="HiddenDocumentLink">Video</a>&nbsp;</div>
                </div>`}
            </div>
            <div class="RowBottom"><div class="MainScreenText RowDetails">${m.board} - ${m.type}</div></div>
        </div>`;
}

export const MEETINGS = [
  { id: 9001, day: 2, time: "9:00 AM", board: "Board of Supervisors", type: "Regular Meeting", status: "Scheduled", agenda: 7001 },
  { id: 9002, day: 4, time: "9:00 AM", board: "Planning Commission", type: "Regular Meeting", status: "Scheduled", agenda: 7002, listed: false },
  { id: 9003, day: 6, time: "1:00 PM", board: "Parks and Recreation Commission", type: "Regular Meeting", status: "Scheduled", agenda: 7003 },
  { id: 9004, day: 9, time: "9:00 AM", board: "Board of Supervisors", type: "Regular Meeting", status: "Scheduled", agenda: null },
  { id: 9005, day: -5, time: "9:00 AM", board: "Board of Supervisors", type: "Regular Meeting", status: "Closed", agenda: 7005, minutes: 8005 },
  { id: 9006, day: 11, time: "9:00 AM", board: "Planning Commission", type: "Regular Meeting", status: "Cancelled", agenda: null },
  // Past meetings with hidden links: 9007 is inside the 30-day backfill, 9008 isn't.
  { id: 9007, day: -20, time: "9:00 AM", board: "Board of Supervisors", type: "Regular Meeting", status: "Closed", agenda: 7007, listed: false },
  { id: 9008, day: -40, time: "9:00 AM", board: "Board of Supervisors", type: "Regular Meeting", status: "Closed", agenda: 7008, listed: false },
  // The county has withdrawn this one's page for now, as it does after a meeting.
  { id: 9009, day: -10, time: "9:00 AM", board: "Planning Commission", type: "Regular Meeting", status: "Closed", agenda: 7009, listed: false, withdrawn: true },
];

export function calendarHtml() {
  return `<html><body><div id="MeetingListCalendar">${MEETINGS.map(row).join("")}</div></body></html>`;
}

export function rssHtml() {
  const pub = (n) => dayFromToday(n).toUTCString();
  return `<?xml version="1.0" encoding="utf-16"?><html><body>${MEETINGS.filter((m) => m.agenda)
    .map(
      (m) => `<div><h2>${m.board} - Agenda</h2><p><p><a href='https://CalaverasCountyCA.IQM2.com/Citizens/Detail_Meeting.aspx?ID=${m.id}'>View Web Agenda</a></p></p><p><em>
      Published on: ${pub(m.day - 4)}</em></p></div>`
    )
    .join("")}</body></html>`;
}

const section = (t) => `<tr><td class='Num'><strong></strong></td><td class='Title' colspan='10'><strong>${t}</strong></td></tr>`;
const item = (n, title, legi) =>
  `<tr><td></td><td class='Num'>${n}. </td><td class='Title' colspan='9'>${legi ? `<a target='_top' class='Link'  href='Detail_LegiFile.aspx?Frame=&MeetingID=9001&MediaPosition=&ID=${legi}&CssClass='>${title}</a>` : title}</td></tr>`;
const attach = (label, href, printout) =>
  printout
    ? `<tr><td></td><td></td><td class='Num'><img src='/Citizens/images/DocumentIcon.gif' alt='document'></td><td class='Title' colspan='8'><a href='${href}'>${label}</a></td></tr>`
    : `<tr><td></td><td></td><td class='Num'>a. </td><td class='Title' colspan='8'><a target='_blank' class='Link'  href='${href}'>${label}</a></td></tr>`;

/** The web agenda for a fake meeting. All items are invented. */
export function meetingHtml(id) {
  const m = MEETINGS.find((x) => String(x.id) === String(id));
  if (!m) return null;
  // A withdrawn page, word for word as the portal shows it.
  if (m.withdrawn) {
    return `<html><body><div id="ContentPlaceholder1_divMeeting">${m.board} Regular Meeting</div>
  <div class="Message">The meeting is not available at this time, please check back later</div>
  <a href="javascript:history.back()">Go back to the page you were on.</a></body></html>`;
  }
  // No agenda posted yet: the page has no agenda links and an empty outline.
  if (!m.agenda) return `<html><body><span id="ContentPlaceholder1_lblOutline"></span></body></html>`;
  const rows =
    m.board === "Planning Commission"
      ? [
          section("Call to Order"),
          section("Public Hearings"),
          item(1, "[TEST] Conditional Use Permit 2026-99 for a fictional gravel yard on Example Road; find exempt from CEQA.", 501),
          attach("Staff Report Printout", "FileOpen.aspx?Type=30&ID=601&MeetingID=9002", true),
          item(2, "[TEST] Amend the zoning text for fictional accessory dwelling rules.", 502),
        ]
      : [
          section("Call to Order"),
          `<tr><td></td><td class='Num'></td><td class='Title' colspan='9'>Roll Call</td></tr>`,
          section("Closed Session Agenda"),
          item(1, "[TEST] Conference with legal counsel regarding a fictional matter, Example v. County."),
          section("General Public Comment - 30 Minutes"),
          section("Consent Agenda"),
          item(2, "[TEST] Approve a fictional contract with Example Paving Co. for road repair, not to exceed $250,000.", 301),
          attach("Agreement Printout", `FileOpen.aspx?Type=30&ID=401&MeetingID=${id}`, true),
          attach("Example Paving Co. Agreement", `FileOpen.aspx?Type=4&ID=402&MeetingID=${id}`),
          item(3, "[TEST] Adopt a fictional resolution setting fees for a sample permit program.", 302),
          attach("Resolution Printout", `FileOpen.aspx?Type=30&ID=403&MeetingID=${id}`, true),
          section("Regular Agenda"),
          item(4, "[TEST] Receive a fictional report on the budget for fiscal year 2026-27 and give direction.", 303),
          attach("Action Item Printout", `FileOpen.aspx?Type=30&ID=404&MeetingID=${id}`, true),
          item(5, "[TEST] Discuss a fictional change to the time limit for public comment at Board meetings.", 304),
          section("Adjournment"),
        ];
  return `<html><body>
  <a id="ContentPlaceholder1_hlPublicAgendaFile" class="tracked Link" data-type="agenda" href="FileOpen.aspx?Type=14&amp;ID=${m.agenda}&amp;Inline=True" target="_blank">Agenda</a>
  <a id="ContentPlaceholder1_hlFullAgendaFile" class="tracked Link" data-type="agenda_packet" href="FileOpen.aspx?Type=1&amp;ID=${m.agenda}&amp;Inline=True" target="_blank">Agenda Packet</a>
  <span id="ContentPlaceholder1_lblOutline"><table id='MeetingDetail' class='MeetingDetail' cellpadding='0' cellspacing='0'>
${rows.join("\n")}
</table></span></body></html>`;
}

/** The agenda PDF's text (fake), in lines, the way a PDF breaks them. */
export function agendaLines(id) {
  const m = MEETINGS.find((x) => String(x.agenda) === String(id));
  if (!m) return null;
  if (m.board === "Planning Commission") {
    return [
      ["TEST COUNTY PLANNING COMMISSION", "[FAKE AGENDA FOR TESTS]", "Members of the public may comment in person at the meeting.", "Written comments received by 5:00 pm on the Monday before the", "meeting will be forwarded to the Commission."],
    ];
  }
  return [
    [
      "TEST COUNTY BOARD OF SUPERVISORS",
      "[FAKE AGENDA FOR TESTS]",
      "This meeting is open to the public. Alternatively, members of the",
      "public may observe the meeting remotely via Zoom, and may comment via Zoom, using the",
      "instructions below.",
      "If you wish to watch the meeting, but not comment, the meeting video is also available for",
      "viewing on YouTube: https://www.youtube.com/@ExampleCountyClerk/streams",
      "As an alternative to commenting in person or via Zoom, you can make a public comment by",
      "e-mailing the Clerk of the Board, clerk@example.gov, no later than 4:00 pm on",
      "the day before the Board meeting. Please clearly indicate which agenda item number your",
      "comment pertains to.",
    ],
    ["9:00 AM: Call to Order", "To view or give public comment virtually, register in advance: https://us02web.", "zoom.us/webinar/register/WN_FAKEtest123", "Once registered you will receive a confirmation email."],
  ];
}

/** A minimal, valid PDF with one text line per row. */
export function makePdf(pages) {
  const esc = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const objs = [];
  const add = (body) => objs.push(body) && objs.length;
  const catalog = add(null);
  const pagesObj = add(null);
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const kids = [];
  for (const lines of pages) {
    const stream = `BT /F1 10 Tf 12 TL 50 760 Td ${lines.map((l) => `(${esc(l)}) Tj T*`).join(" ")} ET`;
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
