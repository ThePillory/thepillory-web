// Line icons (24×24, drawn with currentColor) for topics and other small
// labels. Decorative only: every icon sits beside its words and is hidden from
// screen readers. Pure: shared by the Functions and their tests.

const svg = (body) =>
  `<svg class="icon" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;

const PATHS = {
  water: '<path d="M12 3.5c3 4 5.5 7 5.5 10a5.5 5.5 0 0 1-11 0c0-3 2.5-6 5.5-10z"/>',
  wildfire: '<path d="M12 21a6 6 0 0 0 6-6c0-4-3-6-4-9-1 2-2 3-3.5 3.5C9 8 9 6 9.5 4.5 7 6.5 6 10 6 15a6 6 0 0 0 6 6z"/><path d="M12 21a2.5 2.5 0 0 1-2.5-2.5c0-1.5 1.5-2.5 2.5-4 1 1.5 2.5 2.5 2.5 4A2.5 2.5 0 0 1 12 21z"/>',
  "roads-transportation": '<path d="M8 3 5 21"/><path d="m16 3 3 18"/><path d="M12 4v2.5M12 10.5v3M12 17.5V20"/>',
  housing: '<path d="M4 11 12 4l8 7"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-5h4v5"/>',
  "land-use": '<path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><path d="M9 4v14M15 6v14"/>',
  "taxes-budget": '<circle cx="12" cy="12" r="8.5"/><path d="M14.8 9.2c-.5-.8-1.5-1.2-2.8-1.2-1.6 0-2.8.8-2.8 2s1.2 1.7 2.8 2 2.8.8 2.8 2-1.2 2-2.8 2c-1.3 0-2.4-.5-2.9-1.3M12 6.5V8M12 16v1.5"/>',
  schools: '<path d="M2.5 9 12 4.5 21.5 9 12 13.5z"/><path d="M6.5 11v4.5c1.5 1.5 3.5 2.2 5.5 2.2s4-.7 5.5-2.2V11"/><path d="M21.5 9v5"/>',
  "public-safety": '<path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z"/><path d="m9 12 2 2 4-4"/>',
  health: '<path d="M12 20s-7.5-4.6-7.5-10A4.2 4.2 0 0 1 12 7.6 4.2 4.2 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z"/>',
  "social-services": '<circle cx="9" cy="8" r="3"/><path d="M3.5 19c.5-3 2.8-5 5.5-5s5 2 5.5 5"/><path d="M16 11.5a2.5 2.5 0 1 0 0-5M17.5 14c1.7.5 2.8 2.3 3 5"/>',
  environment: '<path d="M5 19c0-8 5-13 14-14-1 9-6 14-14 14z"/><path d="M5 19c3-4 6-6.5 9.5-8.5"/>',
  energy: '<path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/>',
  agriculture: '<path d="M12 21V9"/><path d="M12 13c-3 0-5-2-5-5 3 0 5 2 5 5zM12 13c3 0 5-2 5-5-3 0-5 2-5 5zM12 9c-2 0-3.5-1.5-3.5-3.5C10.5 5.5 12 7 12 9zM12 9c2 0 3.5-1.5 3.5-3.5C13.5 5.5 12 7 12 9z"/>',
  "jobs-economy": '<rect x="3.5" y="7.5" width="17" height="12" rx="2"/><path d="M9 7.5V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5M3.5 13h17"/>',
  technology: '<path d="M3 9.5a13 13 0 0 1 18 0M6 13a8.5 8.5 0 0 1 12 0M9 16.5a4 4 0 0 1 6 0"/><circle cx="12" cy="19.5" r=".6" fill="currentColor"/>',
  veterans: '<path d="M12 3.5l2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 15.9l-4.8 2.5.9-5.4-3.9-3.8 5.4-.8z"/>',
  defense: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.5 3.5 5.5 3.5 8.5s-1 6-3.5 8.5c-2.5-2.5-3.5-5.5-3.5-8.5s1-6 3.5-8.5z"/>',
  immigration: '<rect x="5" y="3.5" width="14" height="17" rx="2"/><circle cx="12" cy="10" r="3"/><path d="M8.5 16.5h7"/>',
  "government-elections": '<rect x="4.5" y="4.5" width="15" height="15" rx="2.5"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  // Navigation and small labels
  home: '<path d="M4 11 12 4l8 7"/><path d="M6 9.5V20h4.5v-5h3v5H18V9.5"/>',
  reps: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c.5-3.5 3-5.5 6-5.5s5.5 2 6 5.5"/><circle cx="17" cy="9" r="2.4"/><path d="M16.5 14.6c2.4.2 4 2 4.5 4.9"/>',
  laws: '<path d="M12 3.5v17M7 20.5h10M4.5 7.5h15"/><path d="m6.5 7.5-3 6.5a3 3 0 0 0 6 0zM17.5 7.5l-3 6.5a3 3 0 0 0 6 0z"/>',
  you: '<circle cx="12" cy="8" r="4"/><path d="M4.5 21c.6-4 3.6-6.5 7.5-6.5s6.9 2.5 7.5 6.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  community: '<path d="M4 11 12 4l8 7"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-5h4v5"/>',
  map: '<path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><path d="M9 4v14M15 6v14"/>',
};

/** One icon by name; an unknown name draws nothing. */
export function icon(name) {
  const p = PATHS[name];
  return p ? svg(p) : "";
}

export const ICON_NAMES = Object.keys(PATHS);
