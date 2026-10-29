// The part of Sceleton that runs in the background.
//
// Every 30 minutes it checks SCeLE, updates the number on the toolbar icon,
// sets up deadline reminders and tells you when something new shows up.

import { syncCore, syncContents } from './lib/data.js';
import { setHtmlParser } from './lib/scele.js';
import * as store from './lib/store.js';
import { now, rel, safeName, HOUR, DAY, stripHtml } from './lib/util.js';

const REFRESH = 'refresh';
const DASHBOARD = chrome.runtime.getURL('app/index.html');

// ------------------------------------------------------------ HTML parsing helper

let offscreenReady = null;

function ensureOffscreen() {
  // Only one offscreen page may exist, so everyone shares one "create" call.
  offscreenReady ||= (async () => {
    const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (existing.length) return;
    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen/offscreen.html',
        reasons: ['DOM_PARSER'],
        justification: 'Read SCeLE course pages to spot newly uploaded material',
      });
    } catch (e) {
      if (!/single offscreen/i.test(String(e))) throw e;
    }
  })().catch((e) => { offscreenReady = null; throw e; });
  return offscreenReady;
}

setHtmlParser(async (kind, html) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    await ensureOffscreen();
    try {
      const res = await chrome.runtime.sendMessage({ target: 'offscreen', kind, html });
      if (res?.ok) return res.data;
      throw new Error(res?.error || 'Could not read the page');
    } catch (e) {
      // The page may have been closed by Chrome, or not be listening yet.
      if (!/Receiving end|message port closed/i.test(String(e)) || attempt === 2) throw e;
      offscreenReady = null;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  return null;
});

// Everything that writes course pages goes through here, one job at a time.
let queue = Promise.resolve();
function serial(job) {
  const run = queue.then(job, job);
  queue = run.catch(() => {});
  return run;
}

// ------------------------------------------------------------ refreshing

let running = null;

function refresh({ force = false } = {}) {
  if (running) return running;
  running = (async () => {
    const settings = await store.getSettings();
    const res = await syncCore();
    if (res.ok) {
      if (settings.notifyInbox) {
        for (const n of res.newInbox.slice(0, 3)) {
          notify(`inbox|${n.id}`, {
            title: n.subject,
            message: stripHtml(n.text).slice(0, 180),
            url: n.url,
          });
        }
      }
      try {
        const tracked = store.trackedCourses(res.courses, settings);
        const { added } = await serial(() => syncContents(tracked, { force, maxAge: force ? 0 : 2 * HOUR }));
        if (settings.notifyMaterials && added.length) notifyMaterials(added);
      } catch (e) {
        console.warn('Sceleton: course pages', e);
      }
      await scheduleReminders(res.events, settings);
    }
    await updateBadge();
    return res;
  })().finally(() => { running = null; });
  return running;
}

function ensureAlarm() {
  chrome.alarms.get(REFRESH, (a) => {
    if (!a) chrome.alarms.create(REFRESH, { periodInMinutes: 30 });
  });
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  ensureAlarm();
  if (reason === 'install') chrome.tabs.create({ url: DASHBOARD });
  refresh();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  refresh();
});

// ------------------------------------------------------------ reminders

async function scheduleReminders(events, settings) {
  const done = await store.get('done', {});
  const alarms = await chrome.alarms.getAll();
  await Promise.all(alarms.filter((a) => a.name.startsWith('remind|')).map((a) => chrome.alarms.clear(a.name)));
  for (const e of store.visibleEvents(events, done, settings)) {
    for (const h of settings.reminders) {
      const when = (e.time - h * HOUR) * 1000;
      if (when > Date.now() + 5000) chrome.alarms.create(`remind|${e.id}|${h}`, { when });
    }
  }
}

async function remind(eventId, hours) {
  const [{ list = [] } = {}, done, settings] = await Promise.all([
    store.get('events', {}), store.get('done', {}), store.getSettings(),
  ]);
  const e = list.find((x) => String(x.id) === eventId);
  if (!e || done[e.id] || settings.hiddenTypes.includes(e.modname)) return;
  const left = e.time - now();
  notify(`event|${e.id}|${hours}`, {
    title: left < HOUR ? `${e.name} is due ${rel(e.time)}` : `Due ${rel(e.time)}: ${e.name}`,
    message: e.course,
    url: e.url,
    urgent: left < 3 * HOUR,
  });
  updateBadge();
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === REFRESH) refresh();
  else if (a.name.startsWith('remind|')) {
    const [, id, h] = a.name.split('|');
    remind(id, Number(h));
  }
});

// ------------------------------------------------------------ notifications

async function notify(id, { title, message, url, urgent = false }) {
  await chrome.storage.session.set({ [`n:${id}`]: url || DASHBOARD });
  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: 'icons/128.png',
    title: title || 'Sceleton',
    message: message || '',
    priority: urgent ? 2 : 0,
    requireInteraction: urgent,
  });
}

function notifyMaterials(added) {
  const byCourse = {};
  for (const m of added) (byCourse[m.courseId] ||= []).push(m);
  for (const [courseId, items] of Object.entries(byCourse)) {
    const course = items[0].course;
    notify(`fresh|${courseId}|${now()}`, {
      title: items.length === 1 ? `New in ${course}` : `${items.length} new things in ${course}`,
      message: items.length === 1
        ? `${items[0].name} (${items[0].section})`
        : items.slice(0, 3).map((m) => m.name).join(', ') + (items.length > 3 ? ', ...' : ''),
      url: `${DASHBOARD}#/courses/${courseId}`,
    });
  }
}

chrome.notifications.onClicked.addListener(async (id) => {
  const key = `n:${id}`;
  const url = (await chrome.storage.session.get(key))[key] || DASHBOARD;
  chrome.tabs.create({ url });
  chrome.notifications.clear(id);
  chrome.storage.session.remove(key);
});

// ------------------------------------------------------------ toolbar badge

async function updateBadge() {
  const { events = {}, done = {}, auth = {} } = await store.getMany(['events', 'done', 'auth']);
  const settings = await store.getSettings();
  if (auth.status === 'loggedout') {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#7A8296' });
    await chrome.action.setTitle({ title: 'Sceleton: log in to SCeLE to see your deadlines' });
    return;
  }
  const visible = store.visibleEvents(events.list, done, settings);
  const windowSecs = settings.badge === '3d' ? 3 * DAY : DAY;
  const soon = visible.filter((e) => e.time < now() + windowSecs);
  const urgent = soon.some((e) => e.time < now() + DAY);
  const text = settings.badge === 'off' || !soon.length ? '' : String(soon.length);
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: urgent ? '#E0482C' : '#E8A530' });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: urgent ? '#FFFFFF' : '#1B2235' });
  const span = settings.badge === '3d' ? 'the next 3 days' : 'the next 24 hours';
  await chrome.action.setTitle({
    title: soon.length ? `Sceleton: ${soon.length} due in ${span}` : 'Sceleton: nothing due soon',
  });
}

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  if (changes.done || changes.settings) {
    updateBadge();
    const { events = {} } = await store.getMany(['events']);
    scheduleReminders(events.list || [], await store.getSettings());
  }
});

// ------------------------------------------------------------ downloads

// When we don't know a file's name in advance (it comes from SCeLE when the
// download starts), we remember which folder it should go into here.
const pendingFolders = new Map();

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const folder = pendingFolders.get(item.url);
  if (!folder) return suggest();
  pendingFolders.delete(item.url);
  suggest({ filename: `${folder}/${safeName(item.filename)}`, conflictAction: 'overwrite' });
});

async function downloadFiles(files) {
  const settings = await store.getSettings();
  const root = safeName(settings.downloadFolder || 'SCeLE');
  const downloaded = await store.get('downloaded', {});
  let started = 0;
  for (const f of files) {
    const folder = [root, ...f.folder.map(safeName)].join('/');
    const opts = { url: f.url, conflictAction: 'overwrite', saveAs: false };
    if (f.name) opts.filename = `${folder}/${safeName(f.name)}`;
    else pendingFolders.set(f.url, folder);
    try {
      await chrome.downloads.download(opts);
      downloaded[f.key] = now();
      started++;
    } catch (e) {
      console.warn('Sceleton: download failed', f, e);
    }
  }
  await store.set('downloaded', downloaded);
  return started;
}

// ------------------------------------------------------------ messages from pages

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || msg.target === 'offscreen') return;
  if (msg.type === 'refresh') {
    refresh({ force: !!msg.force }).then(reply);
    return true;
  }
  if (msg.type === 'sync-course') {
    store.get('courses', { list: [] })
      .then(({ list }) => {
        const c = list.find((x) => x.id === msg.id);
        if (!c) throw new Error('Course not found');
        return serial(() => syncContents([c], { force: true }));
      })
      .then(() => reply({ ok: true }))
      .catch((e) => reply({ ok: false, error: e.name === 'NotLoggedIn' ? 'You are logged out of SCeLE.' : e.message }));
    return true;
  }
  if (msg.type === 'page-logged-in') {
    store.get('auth', {}).then((a) => {
      if (a.status !== 'ok' || a.at < now() - 15 * 60) refresh();
    });
  }
  if (msg.type === 'download') {
    downloadFiles(msg.files).then((n) => reply({ started: n }));
    return true;
  }
  if (msg.type === 'open-dashboard') {
    chrome.tabs.create({ url: `${DASHBOARD}${msg.hash || ''}` });
  }
});

chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === 'open-dashboard') chrome.tabs.create({ url: DASHBOARD });
});
