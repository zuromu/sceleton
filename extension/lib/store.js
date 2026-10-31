// Everything Sceleton remembers lives in chrome.storage.local, on your own computer.
//
// Keys:
//   auth       { status: 'ok' | 'loggedout' | 'error', name, userid, error, at }
//   events     { list: [...], at }               upcoming deadlines
//   courses    { list: [...], at }               courses this semester
//   contents   { [courseId]: { sections, at, via } }
//   known      { [courseId]: [moduleId, ...] }  what we've already seen on each course page
//   fresh      { [courseId]: [{ id, name, ... }] } new things since you last looked
//   inbox      { items: [...], unread, lastNotifiedId, at }
//   grades     { list: [...], at, details: { [courseId]: {...} } }
//   done       { [eventId]: true }               deadlines you ticked off yourself
//   downloaded { [fileKey]: timestamp }
//   settings   see DEFAULT_SETTINGS

export const DEFAULT_SETTINGS = {
  reminders: [24, 3],          // hours before a deadline to send a notification
  notifyMaterials: true,       // notify when a lecturer adds something to a course
  notifyInbox: true,           // notify for new SCeLE notifications (announcements, grades, ...)
  badge: '24h',                // what the toolbar number counts: '24h', '3d' or 'off'
  hiddenTypes: ['attendance'], // deadline types you never want to see
  darkScele: false,            // dark mode on scele.cs.ui.ac.id itself
  countdown: true,             // live countdown on assignment and quiz pages
  theme: 'auto',               // 'auto', 'light' or 'dark' for Sceleton's own pages
  downloadFolder: 'SCeLE',     // inside your Downloads folder
  hiddenCourses: [],           // courses you're enrolled in but not really taking
  coursesChosen: false,        // has the "pick your courses" tip been dealt with?
  exportDetails: true,         // "Export for Claude" also reads assignment descriptions and pages
};

export async function get(key, fallback) {
  const out = await chrome.storage.local.get(key);
  return out[key] ?? fallback;
}

export async function getMany(keys) {
  return chrome.storage.local.get(keys);
}

export function set(key, value) {
  return chrome.storage.local.set({ [key]: value });
}

export async function update(key, fn, fallback = {}) {
  const value = await fn(await get(key, fallback));
  await set(key, value);
  return value;
}

export async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await get('settings', {})) };
}

export async function saveSettings(patch) {
  const s = { ...(await getSettings()), ...patch };
  await set('settings', s);
  return s;
}

// Is Sceleton dark right now? ('auto' follows the computer.)
export function isDark(settings) {
  if (settings.theme === 'dark') return true;
  if (settings.theme === 'light') return false;
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches;
}

export function toggleTheme(settings) {
  return saveSettings({ theme: isDark(settings) ? 'light' : 'dark' });
}

// Deadlines that still matter: not ticked off, not a hidden type, not from
// a course you said you aren't taking.
export function visibleEvents(events, done = {}, settings = DEFAULT_SETTINGS, { includeDone = false } = {}) {
  const hiddenCourses = settings.hiddenCourses || [];
  return (events || []).filter((e) =>
    (includeDone || !done[e.id])
    && !settings.hiddenTypes.includes(e.modname)
    && !hiddenCourses.includes(e.courseId));
}

// Courses you're actually taking.
export function trackedCourses(courses, settings = DEFAULT_SETTINGS) {
  const hidden = settings.hiddenCourses || [];
  return (courses || []).filter((c) => !hidden.includes(c.id));
}
