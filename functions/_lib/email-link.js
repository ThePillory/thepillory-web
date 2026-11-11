// The weekly email's one-line link (docs/email.md): under Your representatives on Home, on
// county pages and on /briefing/. The You tab and the footer link it from tools/build.py.
export const EMAIL_HREF = "/email/";
export function emailLine(text = "Get your representatives' week by email, every Sunday") {
  return `<p class="small email-line simple-keep"><a class="inline-link" href="${EMAIL_HREF}">${text} ›</a></p>`;
}
