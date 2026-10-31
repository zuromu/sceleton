// Line icons drawn on a 24x24 grid. icon('home') returns an <svg> string.

const P = {
  home: '<path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z"/>',
  deadlines: '<circle cx="12" cy="13" r="7.5"/><path d="M12 9v4l2.5 2.5M9.5 2.5h5M12 2.5v3"/>',
  courses: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5zM13 4h5.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H13z"/>',
  inbox: '<path d="M4 13.5 6.2 5.6A1.5 1.5 0 0 1 7.6 4.5h8.8a1.5 1.5 0 0 1 1.4 1.1L20 13.5V18a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18zM4 13.5h4.5l1.5 2.5h4l1.5-2.5H20"/>',
  grades: '<path d="M5 20V11M10 20V5M15 20v-6M20 20V8"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7M18.5 18.5l-1.7-1.7M7.2 7.2 5.5 5.5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.6-4.5M4 4v3.5h3.5M4 13a8 8 0 0 0 14.6 4.5M20 20v-3.5h-3.5"/>',
  download: '<path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19.5h14"/>',
  external: '<path d="M14 4h6v6M20 4l-8.5 8.5M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  calendar: '<rect x="4" y="5.5" width="16" height="14.5" rx="1.5"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
  resource: '<path d="M14 3.5H7.5A1.5 1.5 0 0 0 6 5v14a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V7.5zM14 3.5V7.5h4M9 12.5h6M9 16h6"/>',
  folder: '<path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h4.2l2 2.5H19a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18z"/>',
  url: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  assign: '<path d="M15.5 4.5 19.5 8.5 9 19H5v-4z"/><path d="m13 7 4 4"/>',
  quiz: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.4M12 16.8v.2"/>',
  forum: '<path d="M4 6a1.5 1.5 0 0 1 1.5-1.5h13A1.5 1.5 0 0 1 20 6v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5v-3.5h0A1.5 1.5 0 0 1 4 15z"/>',
  page: '<rect x="5.5" y="3.5" width="13" height="17" rx="1.5"/><path d="M9 8h6M9 11.5h6M9 15h3.5"/>',
  attendance: '<rect x="4.5" y="4.5" width="15" height="15" rx="2"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  other: '<circle cx="12" cy="12" r="1.2"/><circle cx="6.5" cy="12" r="1.2"/><circle cx="17.5" cy="12" r="1.2"/>',
  moon: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M21.5 12h-2M4.5 12h-2M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4M18.7 18.7l-1.4-1.4M6.7 6.7 5.3 5.3"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0"/>',
  arrowLeft: '<path d="M19 12H5m0 0 6-6m-6 6 6 6"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  logout: '<path d="M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14M10 16l-4-4 4-4M6 12h10"/>',
  export: '<path d="M12 15V4m0 0L8 8m4-4 4 4M5 13v5.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V13"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="1.5"/><path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
  archive: '<path d="M4 6.5h16V10H4zM5.5 10v8.5A1.5 1.5 0 0 0 7 20h10a1.5 1.5 0 0 0 1.5-1.5V10M10 13.5h4"/>',
};

const MOD_ICON = { assign: 'assign', quiz: 'quiz', forum: 'forum', resource: 'resource', folder: 'folder', url: 'url', page: 'page', book: 'page', attendance: 'attendance', workshop: 'assign', lesson: 'page' };

export function icon(name, size = 18) {
  const body = P[name] || P[MOD_ICON[name]] || P.other;
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

// The Sceleton mark: a small skull.
export function logo(size = 24) {
  return `<svg class="logo" width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true">
    <path fill="currentColor" d="M16 3C9.4 3 5 7.6 5 13.6c0 3.5 1.5 6.2 4 7.8V25a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3.6c2.5-1.6 4-4.3 4-7.8C27 7.6 22.6 3 16 3z"/>
    <ellipse cx="11.6" cy="14.2" rx="2.7" ry="3" fill="var(--logo-hole, #fff)"/>
    <ellipse cx="20.4" cy="14.2" rx="2.7" ry="3" fill="var(--logo-hole, #fff)"/>
    <path fill="var(--logo-hole, #fff)" d="M16 18.2l1.6 2.4h-3.2z"/>
    <path stroke="var(--logo-hole, #fff)" stroke-width="1.4" d="M13.3 23.2v3.6M16 23.2v3.6M18.7 23.2v3.6"/>
  </svg>`;
}
