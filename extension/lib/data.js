// Keeps the saved copy of your SCeLE data up to date.
// Used by the background worker (every 30 minutes) and by the dashboard.

import * as scele from './scele.js';
import * as store from './store.js';
import { now } from './util.js';

// Runs `fn` over `items`, at most `limit` at a time, so we don't hammer SCeLE.
async function pool(items, limit, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

// Deadlines, courses and notifications. Returns new notifications so the
// caller can decide whether to pop them up.
export async function syncCore() {
  try {
    const s = await scele.getSession(true);
    const [events, courses] = await Promise.all([scele.getEvents(), scele.getCourses()]);
    const t = now();
    await chrome.storage.local.set({
      events: { list: events, at: t },
      courses: { list: courses, at: t },
      auth: { status: 'ok', name: s.name, userid: s.userid, at: t },
    });
    let newInbox = [];
    try {
      newInbox = await syncInbox();
    } catch (e) {
      if (e instanceof scele.NotLoggedIn) throw e;
      console.warn('Sceleton: notifications unavailable', e);
    }
    return { ok: true, events, courses, newInbox };
  } catch (e) {
    if (e instanceof scele.NotLoggedIn) {
      await store.set('auth', { status: 'loggedout', at: now() });
      return { ok: false, loggedOut: true };
    }
    console.warn('Sceleton: sync failed', e);
    await store.update('auth', (a) => ({ ...a, status: a.status || 'error', error: e.message, errorAt: now() }));
    return { ok: false, error: e.message };
  }
}

export async function syncInbox() {
  const { items, unread } = await scele.getNotifications();
  const prev = await store.get('inbox', {});
  const maxId = Math.max(0, ...items.map((n) => n.id));
  // First time: remember where we are, don't pop up old stuff.
  const lastId = prev.lastNotifiedId ?? maxId;
  const fresh = items.filter((n) => !n.read && n.id > lastId);
  await store.set('inbox', { items, unread, lastNotifiedId: Math.max(lastId, maxId), at: now() });
  return fresh;
}

// Compares a course page with what we saw last time and remembers anything new.
// `known` and `fresh` are updated in place; the caller saves them.
function detectFresh(course, sections, known, fresh) {
  const mods = sections.flatMap((s) => s.modules.map((m) => ({ ...m, section: s.name })));
  const before = known[course.id];
  known[course.id] = [...new Set([...(before || []), ...mods.map((m) => m.id)])];
  let added = [];
  if (before) {
    const seen = new Set(before);
    added = mods.filter((m) => !seen.has(m.id)).map((m) => ({
      id: m.id, name: m.name, modname: m.modname, url: m.url, section: m.section,
      courseId: course.id, course: course.shortname, at: now(),
    }));
    if (added.length) fresh[course.id] = [...(fresh[course.id] || []), ...added];
  }
  return added;
}

// Course pages. Skips ones fetched in the last `maxAge` seconds.
// Returns { added: [new modules], unavailable: bool }
export async function syncContents(courses, { maxAge = 2 * 3600, force = false } = {}) {
  const saved = await store.getMany(['contents', 'known']);
  const due = courses.filter((c) => force || !saved.contents?.[c.id] || saved.contents[c.id].at < now() - maxAge);
  let unavailable = false;
  const results = [];
  await pool(due, 3, async (c) => {
    if (unavailable) return;
    try {
      const { sections, via } = await scele.getContents(c.id);
      results.push({ c, sections, via });
    } catch (e) {
      if (e instanceof scele.Unavailable) unavailable = true;
      else if (e instanceof scele.NotLoggedIn) throw e;
      else console.warn('Sceleton: could not load course', c.id, e);
    }
  });

  // Read the latest saved copy right before writing, and only change the
  // courses we just loaded, so we don't undo anything that happened meanwhile
  // (like you opening a course, which clears its "new" marker).
  const { contents = {}, known = {}, fresh = {} } = await store.getMany(['contents', 'known', 'fresh']);
  const added = [];
  for (const { c, sections, via } of results) {
    contents[c.id] = { sections, via, at: now() };
    added.push(...detectFresh(c, sections, known, fresh));
  }
  await chrome.storage.local.set({ contents, known, fresh });
  return { added, unavailable };
}

export async function markCourseSeen(courseId) {
  await store.update('fresh', (f) => { delete f[courseId]; return f; });
}

export async function syncGrades() {
  const [list, courses] = await Promise.all([scele.getGradeOverview(), store.get('courses', { list: [] })]);
  const names = Object.fromEntries(courses.list.map((c) => [c.id, c]));
  const grades = await store.get('grades', {});
  grades.list = list.map((g) => ({ ...g, name: g.name || names[g.courseId]?.fullname || `Course ${g.courseId}` }));
  grades.at = now();
  await store.set('grades', grades);
  return grades;
}

export async function syncCourseGrades(courseId) {
  const items = await scele.getCourseGrades(courseId);
  const grades = await store.get('grades', {});
  grades.details = { ...(grades.details || {}), [courseId]: { items, at: now() } };
  await store.set('grades', grades);
  return items;
}

export async function toggleDone(eventId) {
  return store.update('done', (d) => {
    if (d[eventId]) delete d[eventId];
    else d[eventId] = now();
    return d;
  });
}
