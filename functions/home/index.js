// /home/ moved to /: the Home briefing is the site's front page now.
export function onRequestGet({ request }) {
  const url = new URL(request.url);
  return Response.redirect(`${url.origin}/${url.search}`, 301);
}
