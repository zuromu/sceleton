// The small window that opens when you click the Sceleton icon.

import * as store from '../lib/store.js';
import * as data from '../lib/data.js';
import { urls } from '../lib/scele.js';
import { icon, logo } from '../lib/icons.js';
import { summary, spine, groupedList } from '../lib/views.js';
import { esc, now, rel, DAY } from '../lib/util.js';

const app = document.getElementById('app');
const DASH = chrome.runtime.getURL('app/index.html');
let db = {};
let settings = store.DEFAULT_SETTINGS;
let syncing = false;

function openTab(url) {
  chrome.tabs.create({ url });
  window.close();
}

function render() {
  const auth = db.auth || {};
  const head = `<header>
    <span class="brand">${logo(22)}Sceleton</span>
    <button class="icon-btn" data-act="theme" title="${store.isDark(settings) ? 'Light mode' : 'Dark mode'}" aria-label="${store.isDark(settings) ? 'Switch to light mode' : 'Switch to dark mode'}">${icon(store.isDark(settings) ? 'sun' : 'moon', 17)}</button>
    <button class="icon-btn${syncing ? ' spinning' : ''}" data-act="sync" title="Sync now" aria-label="Sync now">${icon('refresh', 17)}</button>
    <button class="icon-btn" data-act="dash" title="Open dashboard" aria-label="Open dashboard">${icon('external', 17)}</button>
  </header>`;

  if (auth.status === 'loggedout') {
    app.innerHTML = `${head}<div class="hello">
      <h1>Log in to SCeLE first.</h1>
      <p>Sceleton uses the login in your browser. It never sees your password.</p>
      <button class="btn primary" data-act="login">${icon('external', 16)}Open SCeLE login</button>
    </div>`;
    return;
  }
  if (!db.events) {
    app.innerHTML = `${head}<div class="hello"><h1>Checking SCeLE...</h1><p>This only takes a moment the first time.</p></div>`;
    return;
  }

  const ev = store.visibleEvents(db.events.list, db.done || {}, settings);
  const s = summary(ev);
  const next = ev.filter((e) => e.time < now() + 14 * DAY).slice(0, 5);
  const freshAll = Object.values(db.fresh || {}).flat().filter((m) => !(settings.hiddenCourses || []).includes(m.courseId));
  const freshCount = freshAll.length;
  const freshCourses = [...new Set(freshAll.map((m) => m.course))];
  const unread = db.inbox?.unread || 0;
  const firstUnread = (db.inbox?.items || []).find((n) => !n.read);

  app.innerHTML = `${head}
    <div class="lead"><h1>${esc(s.title)}</h1><p>${esc(s.sub)}</p></div>
    <div class="spine-wrap">${spine(ev, 7)}</div>
    <div class="list">
      ${next.length ? groupedList(next, db.done || {}, { compact: true }) : '<div class="group-label">Nothing in the next two weeks</div><div style="height:8px"></div>'}
      <a class="more" href="#" data-act="dash" data-hash="#/deadlines">See all deadlines</a>
    </div>
    ${freshCount || unread ? `<div class="extras">
      ${freshCount ? `<button class="extra" data-act="dash" data-hash="#/courses">${icon('courses', 17)}<span class="grow">${freshCount} new in ${esc(freshCourses.slice(0, 2).join(', '))}${freshCourses.length > 2 ? ` and ${freshCourses.length - 2} more` : ''}</span><span class="pill fresh">New</span></button>` : ''}
      ${unread ? `<button class="extra" data-act="dash" data-hash="#/inbox">${icon('inbox', 17)}<span class="grow">${esc(firstUnread ? firstUnread.subject : 'New notifications')}</span><span class="pill">${unread}</span></button>` : ''}
    </div>` : ''}
    <footer>
      <button class="btn primary" data-act="dash">Open dashboard</button>
      <button class="btn" data-act="scele">${icon('external', 15)}SCeLE</button>
    </footer>
    <div class="stamp">${db.events.at ? `Synced ${esc(rel(db.events.at))}` : ''}</div>`;
}

async function sync() {
  if (syncing) return;
  syncing = true;
  render();
  try { await chrome.runtime.sendMessage({ type: 'refresh' }); } catch (e) { /* worker restarting */ }
  syncing = false;
  render();
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  e.preventDefault();
  const act = el.dataset.act;
  if (act === 'sync') sync();
  else if (act === 'theme') settings = await store.toggleTheme(settings);
  else if (act === 'dash') openTab(DASH + (el.dataset.hash || ''));
  else if (act === 'scele') openTab(urls.home);
  else if (act === 'login') openTab(urls.login);
  else if (act === 'done') await data.toggleDone(Number(el.dataset.id));
  else if (act === 'day') openTab(`${DASH}#/deadlines`);
});

// Links to SCeLE open in a new tab instead of inside the popup.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[target="_blank"]');
  if (a) { e.preventDefault(); openTab(a.href); }
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  for (const [k, v] of Object.entries(changes)) db[k] = v.newValue;
  if (changes.settings) {
    settings = await store.getSettings();
    applyTheme();
  }
  render();
});

function applyTheme() {
  const t = settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem('sceleton-theme', t); } catch (e) { /* ignore */ }
}

(async () => {
  db = await chrome.storage.local.get(null);
  settings = await store.getSettings();
  applyTheme();
  render();
  if (!db.events || db.events.at < now() - 10 * 60) sync();
})();
