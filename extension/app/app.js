// The Sceleton dashboard.
//
// How this file works: everything on screen is drawn from `db`, a copy of
// what's saved in chrome.storage. When storage changes (because the
// background worker synced, or you ticked something off), we redraw.
// Each page is a function that returns an HTML string. Clicks are handled in
// one place at the bottom, using data-act="..." attributes.

import * as store from '../lib/store.js';
import * as data from '../lib/data.js';
import * as scele from '../lib/scele.js';
import { icon, logo } from '../lib/icons.js';
import { summary, spine, eventRow, groupedList, hue } from '../lib/views.js';
import {
  esc, now, rel, relShort, fmtDate, fmtTime, fmtLongDate, heat, moduleLabel, fmtSize,
  DAY, HOUR, fuzzy, buildIcs, stripHtml, dayLabel, safeName,
} from '../lib/util.js';

const $ = (sel, el = document) => el.querySelector(sel);
const db = {};
let settings = { ...store.DEFAULT_SETTINGS };

const ui = {
  syncing: false,
  deadlineCourse: null,
  showDone: false,
  gradeOpen: new Set(),
  gradeLoading: new Set(),
  courseLoading: new Set(),
  courseError: {},
  freshShown: {},
  readLocally: new Set(), // notifications opened here, in case a sync races us
  scrollTo: null,
};

// ------------------------------------------------------------ data helpers

const courses = () => db.courses?.list || [];
const tracked = () => store.trackedCourses(courses(), settings);
const isHidden = (id) => (settings.hiddenCourses || []).includes(Number(id));
const courseById = (id) => courses().find((c) => c.id === Number(id));
const allEvents = () => db.events?.list || [];
const visible = (opts) => store.visibleEvents(allEvents(), db.done || {}, settings, opts);
const freshList = () => Object.values(db.fresh || {}).flat().filter((m) => !isHidden(m.courseId)).sort((a, b) => b.at - a.at);
const isEdge = /Edg\//.test(navigator.userAgent);
const browserName = isEdge ? 'Edge' : 'Chrome';
const loggedOut = () => db.auth?.status === 'loggedout';

function syncedText() {
  const at = db.events?.at;
  if (!at) return 'Not synced yet';
  return now() - at < 60 ? 'Synced just now' : `Synced ${rel(at)}`;
}

function firstName() {
  const n = (db.auth?.name || '').trim();
  return n ? n.split(/\s+/)[0] : '';
}

// ------------------------------------------------------------ routing

function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return { page: parts[0] || 'home', id: parts[1] ? Number(parts[1]) : null };
}

const PAGES = [
  ['home', 'Home', 'home'],
  ['deadlines', 'Deadlines', 'deadlines'],
  ['courses', 'Courses', 'courses'],
  ['inbox', 'Inbox', 'inbox'],
  ['grades', 'Grades', 'grades'],
  ['settings', 'Settings', 'settings'],
];

// ------------------------------------------------------------ sidebar

function sidebar() {
  const r = route();
  const unread = unreadCount();
  const fresh = freshList().length;
  const dueSoon = visible().filter((e) => e.time < now() + DAY).length;
  const counts = { inbox: unread, courses: fresh, deadlines: dueSoon };
  const isMac = /Mac/.test(navigator.platform);
  return `
    <a class="brand" href="#/home">${logo(26)}<span>Sceleton</span></a>
    <button class="searchbox" data-act="search" aria-label="Search">${icon('search', 16)}<span>Search</span><kbd>${isMac ? '⌘' : 'Ctrl'} K</kbd></button>
    <div class="nav">
      ${PAGES.map(([key, label, ic]) => `
        <a href="#/${key}" ${r.page === key ? 'aria-current="page"' : ''} title="${label}">
          ${icon(ic)}<span class="label">${label}</span>
          ${counts[key] ? `<span class="pill ${key === 'courses' ? 'fresh' : key === 'deadlines' ? 'count' : ''}">${counts[key]}</span>` : ''}
        </a>`).join('')}
    </div>
    <div class="side-foot">
      <div class="who">${db.auth?.name ? `<b>${esc(db.auth.name)}</b>` : ''}${esc(syncedText())}</div>
      <button class="icon-btn" data-act="theme" title="${store.isDark(settings) ? 'Switch to light mode' : 'Switch to dark mode'}" aria-label="${store.isDark(settings) ? 'Switch to light mode' : 'Switch to dark mode'}">${icon(store.isDark(settings) ? 'sun' : 'moon', 17)}</button>
      <button class="icon-btn${ui.syncing ? ' spinning' : ''}" data-act="sync" title="Sync with SCeLE now" aria-label="Sync with SCeLE now">${icon('refresh', 17)}</button>
    </div>`;
}

// ------------------------------------------------------------ shared bits

function errorBanner() {
  const a = db.auth || {};
  if (!a.errorAt || a.errorAt < (db.events?.at || 0)) return '';
  return `<div class="banner">${icon('bell', 18)}<span class="grow">Couldn't reach SCeLE just now (${esc(a.error || 'unknown error')}). You're seeing what was saved ${esc(rel(db.events?.at || a.errorAt))}.</span><button class="btn small" data-act="sync">Try again</button></div>`;
}

function emptyNote(title, text) {
  return `<div class="empty-note"><b>${esc(title)}</b>${esc(text)}</div>`;
}

function helloPage() {
  return `<div class="hello">
    <div class="mark">${logo(56)}</div>
    <h1>Log in to SCeLE and Sceleton fills itself in.</h1>
    <p>Sceleton reads SCeLE using the login you already have in this browser. It never sees or stores your password, and everything it saves stays on your computer.</p>
    <div class="hello-actions">
      <a class="btn primary" href="${esc(scele.urls.login)}" target="_blank" rel="noopener">${icon('external', 16)}Open SCeLE login</a>
      <button class="btn" data-act="sync">I'm logged in, check again</button>
    </div>
    <p class="small faint">Once you're in, this page updates by itself.</p>
  </div>`;
}

function loadingPage() {
  return `<div class="page">
    <div class="skeleton" style="height:18px;width:180px;margin-bottom:18px"></div>
    <div class="skeleton" style="height:44px;width:min(560px,90%);margin-bottom:12px"></div>
    <div class="skeleton" style="height:44px;width:min(380px,70%);margin-bottom:36px"></div>
    <div class="skeleton" style="height:120px;margin-bottom:36px"></div>
    <div class="skeleton" style="height:260px"></div>
  </div>`;
}

function modIcon(modname, courseId) {
  return `<span class="mod-icon k-${esc(modname)}" style="${hue(courseId)}">${icon(modname, 17)}</span>`;
}

// ------------------------------------------------------------ home

function homePage() {
  const ev = visible().filter((e) => e.time < now() + 60 * DAY);
  const s = summary(ev);
  const upNext = ev.filter((e) => e.time < now() + 14 * DAY).slice(0, 8);
  const fresh = freshList();
  const notes = (db.inbox?.items || []).slice(0, 4);
  const name = firstName();
  const hour = new Date().getHours();
  const greet = hour < 11 ? 'Good morning' : hour < 15 ? 'Good afternoon' : hour < 19 ? 'Good evening' : 'Hi';

  const pickTip = !settings.coursesChosen && courses().length > 1
    ? `<div class="banner tip">${icon('courses', 18)}<span class="grow">Enrolled in courses you're only browsing? Pick the ones you're actually taking and Sceleton will ignore the rest.</span><button class="btn small primary" data-act="pick-courses">Choose courses</button><button class="btn small ghost" data-act="dismiss-pick">Not now</button></div>`
    : '';
  return `<div class="page">
    ${errorBanner()}
    ${pickTip}
    <div class="top"><span>${esc(fmtLongDate(now()))}</span><span class="grow"></span><span class="faint">${esc(greet)}${name ? `, ${esc(name)}` : ''}</span></div>
    <h1 class="headline">${esc(s.title)}</h1>
    <p class="subline">${esc(s.sub)}</p>

    <section class="panel spine-panel" aria-label="Next two weeks">
      ${spine(visible(), 14)}
      <div class="legend">
        <span class="heat-overdue"><i></i>Overdue</span>
        <span class="heat-hot"><i></i>Due within a day</span>
        <span class="heat-warm"><i></i>Within 3 days</span>
        <span class="heat-cool"><i></i>Later</span>
      </div>
    </section>

    <div class="cols">
      <section>
        <h2>Up next <span class="faint">${upNext.length}</span><span class="grow"></span><a href="#/deadlines">All deadlines</a></h2>
        <div class="panel">${upNext.length ? groupedList(upNext, db.done || {}) : emptyNote('Nothing in the next two weeks.', ' New deadlines show up here as soon as they appear on SCeLE.')}</div>
      </section>
      <div class="stack">
        <section>
          <h2>New in your courses ${fresh.length ? `<span class="faint">${fresh.length}</span>` : ''}<span class="grow"></span>${fresh.length ? '<a href="#" data-act="clear-fresh">Mark all seen</a>' : ''}</h2>
          <div class="panel"><ul class="rows">${fresh.length ? fresh.slice(0, 6).map(freshRow).join('') : `<li>${emptyNote('Nothing new since you last looked.', ' When a lecturer adds slides or an assignment, it lands here.')}</li>`}</ul></div>
        </section>
        <section>
          <h2>Inbox ${unreadCount() ? `<span class="faint">${unreadCount()} unread</span>` : ''}<span class="grow"></span><a href="#/inbox">Open inbox</a></h2>
          <div class="panel"><ul class="rows">${notes.length ? notes.map(noteRow).join('') : `<li>${emptyNote('No notifications.', ' Announcements and grading updates from SCeLE show up here.')}</li>`}</ul></div>
        </section>
      </div>
    </div>
  </div>`;
}

function freshRow(m) {
  return `<li class="row">
    ${modIcon(m.modname, m.courseId)}
    <div class="main">
      <a class="title" href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.name)}</a>
      <div class="sub"><a href="#/courses/${m.courseId}">${esc(m.course)}</a><span class="sep"></span>${esc(m.section)}<span class="sep"></span><span class="faint">${esc(rel(m.at))}</span></div>
    </div>
  </li>`;
}

const isRead = (n) => n.read || ui.readLocally.has(n.id);
const unreadCount = () => (db.inbox?.items || []).filter((n) => !isRead(n)).length;

function noteRow(n) {
  return `<li><button class="row note-row${isRead(n) ? '' : ' unread'}" data-act="note" data-id="${n.id}">
    <span class="dot"></span>
    <div class="main">
      <span class="title-line"><span class="title">${esc(n.subject)}</span><span class="when faint">${esc(rel(n.time))}</span></span>
      <span class="snippet">${esc(stripHtml(n.text).slice(0, 220))}</span>
    </div>
  </button></li>`;
}

// ------------------------------------------------------------ deadlines

function deadlinesPage() {
  let ev = visible({ includeDone: ui.showDone });
  const inEvents = [...new Set(ev.map((e) => e.courseId))];
  if (ui.deadlineCourse) ev = ev.filter((e) => e.courseId === ui.deadlineCourse);
  const hiddenCount = allEvents().filter((e) => settings.hiddenTypes.includes(e.modname)).length;
  return `<div class="page">
    ${errorBanner()}
    <h1 class="headline" style="margin-bottom:22px">Deadlines</h1>
    <div class="filters" role="toolbar" aria-label="Filter deadlines">
      <button class="chip" data-act="filter-course" data-id="" aria-pressed="${!ui.deadlineCourse}">All courses</button>
      ${inEvents.map((id) => {
        const c = courseById(id) || { shortname: ev.find((e) => e.courseId === id)?.course || id };
        return `<button class="chip" data-act="filter-course" data-id="${id}" aria-pressed="${ui.deadlineCourse === id}"><span class="cdot" style="${hue(id)}"></span>${esc(c.shortname)}</button>`;
      }).join('')}
      <span class="grow"></span>
      <label class="switch"><span class="toggle"><input type="checkbox" data-act="show-done" ${ui.showDone ? 'checked' : ''}><span></span></span>Show ticked off</label>
      <button class="btn small" data-act="ics">${icon('calendar', 15)}Add to calendar</button>
    </div>
    <div class="panel">${ev.length ? groupedList(ev, db.done || {}) : emptyNote('Nothing here.', ui.deadlineCourse ? ' This course has no upcoming deadlines.' : ' No deadlines in the next two months.')}</div>
    ${hiddenCount ? `<p class="faint" style="margin-top:14px;font-size:var(--t-s)">${hiddenCount} ${hiddenCount === 1 ? 'item is' : 'items are'} hidden because of their type. You can change this in <a href="#/settings">Settings</a>.</p>` : ''}
  </div>`;
}

// ------------------------------------------------------------ courses

function coursesPage() {
  const list = tracked();
  const others = courses().filter((c) => isHidden(c.id));
  return `<div class="page">
    ${errorBanner()}
    <div class="title-row"><h1 class="headline">Courses</h1>${courses().length ? `<button class="btn" data-act="pick-courses">${icon('settings', 16)}Choose courses</button>` : ''}</div>
    ${list.length ? `<div class="course-grid">${list.map(courseCard).join('')}</div>`
      : `<div class="panel">${emptyNote(courses().length ? "You aren't tracking any courses." : 'No courses found.', courses().length ? ' Use Choose courses to pick the ones you are taking.' : ' Courses you are enrolled in this semester show up here.')}</div>`}
    ${others.length ? `<section class="section" style="margin-top:36px">
      <h2>Not taking <span class="faint">${others.length}</span></h2>
      <p class="faint" style="margin:-6px 0 12px;font-size:var(--t-s)">Enrolled, but left out of deadlines, reminders and alerts. You can still open them.</p>
      <div class="panel"><ul class="rows">${others.map((c) => `<li class="row">
        <span class="cdot" style="${hue(c.id)}"></span>
        <div class="main"><a class="title" href="#/courses/${c.id}">${esc(c.fullname)}</a><div class="sub">${esc(c.shortname)}</div></div>
        <button class="btn small" data-act="track" data-id="${c.id}">Start tracking</button></li>`).join('')}</ul></div>
    </section>` : ''}
  </div>`;
}

function courseCard(c) {
  const fresh = (db.fresh?.[c.id] || []).length;
  const next = visible().find((e) => e.courseId === c.id && e.time >= now());
  return `<a class="course-card" href="#/courses/${c.id}" style="${hue(c.id)}">
    <span class="code">${esc(c.shortname)}</span>
    <span class="name">${esc(c.fullname)}</span>
    <div class="foot">
      ${fresh ? `<span class="pill fresh">${fresh} new</span>` : ''}
      ${next ? `<span class="countdown heat-${heat(next.time)}">${esc(relShort(next.time))}</span><span>${esc(next.name)}</span>` : '<span class="faint">No upcoming deadlines</span>'}
    </div>
  </a>`;
}

// Every downloadable file in a course, with the folder it should be saved in.
function courseFiles(course, sections, onlySection = null) {
  const out = [];
  sections.forEach((sec, si) => {
    if (onlySection !== null && si !== onlySection) return;
    for (const m of sec.modules) {
      m.files.forEach((f, fi) => {
        const folder = [course.shortname, sec.name];
        if (m.modname === 'folder') folder.push(m.name, ...f.path.split('/').filter(Boolean));
        out.push({ url: f.url, name: f.name, folder, key: `${f.url}|${f.time}`, mod: m.id, idx: fi });
      });
    }
  });
  return out;
}

function coursePage(id) {
  const c = courseById(id);
  if (!c) return `<div class="page"><div class="panel">${emptyNote('Course not found.', ' It might be from a past semester.')}</div></div>`;
  const content = db.contents?.[id];
  const fresh = new Set((ui.freshShown[id] || []).map((m) => m.id));
  const loading = ui.courseLoading.has(id);
  const sections = content?.sections || [];
  const files = courseFiles(c, sections);
  const fresh2dl = files.filter((f) => !db.downloaded?.[f.key]).length;
  const ev = visible().filter((e) => e.courseId === id);

  let body;
  if (!content && loading) {
    body = '<div class="skeleton" style="height:240px;margin-bottom:20px"></div><div class="skeleton" style="height:180px"></div>';
  } else if (!content) {
    body = `<div class="panel">${emptyNote("Couldn't load this course.", ` ${ui.courseError[id] || ''}`)}<div style="padding:0 18px 18px"><button class="btn small" data-act="reload-course" data-id="${id}">Try again</button></div></div>`;
  } else {
    body = sections.map((sec, si) => {
      const secFiles = sec.modules.reduce((n, m) => n + m.files.length, 0);
      return `<section class="section">
        <h2>${esc(sec.name)} <span class="faint">${sec.modules.length}</span><span class="grow"></span>
          ${secFiles ? `<button class="btn small ghost" data-act="dl-section" data-id="${id}" data-sec="${si}">${icon('download', 15)}Download ${secFiles === 1 ? 'file' : `${secFiles} files`}</button>` : ''}</h2>
        <div class="panel"><ul class="rows">${sec.modules.map((m) => moduleRow(c, m, fresh.has(m.id))).join('')}</ul></div>
      </section>`;
    }).join('') || `<div class="panel">${emptyNote('This course page is empty.', ' Nothing has been posted yet.')}</div>`;
  }

  const hiddenNote = isHidden(id)
    ? `<div class="banner tip">${icon('courses', 18)}<span class="grow">You marked this as a course you're not taking, so its deadlines and new material are left out everywhere else.</span><button class="btn small" data-act="track" data-id="${id}">Start tracking</button></div>`
    : '';
  return `<div class="page">
    ${errorBanner()}
    ${hiddenNote}
    <header class="panel course-head" style="${hue(id)}">
      <a class="back" href="#/courses">${icon('arrowLeft', 15)}All courses</a>
      <h1>${esc(c.fullname)}</h1>
      <div class="name">${esc(c.shortname)}${content ? `<span class="faint">, updated ${esc(rel(content.at))}</span>` : ''}</div>
      <div class="actions">
        ${files.length ? `<button class="btn primary" data-act="dl-course" data-id="${id}">${icon('download', 16)}${fresh2dl ? `Download ${fresh2dl === files.length ? 'all' : 'new'} files (${fresh2dl})` : 'Download all again'}</button>` : ''}
        <a class="btn" href="${esc(c.url)}" target="_blank" rel="noopener">${icon('external', 16)}Open in SCeLE</a>
        <button class="btn ghost${loading ? ' spinning' : ''}" data-act="reload-course" data-id="${id}">${icon('refresh', 16)}Refresh</button>
      </div>
    </header>
    ${ev.length ? `<section class="section"><h2>Deadlines <span class="faint">${ev.length}</span></h2><div class="panel">${groupedList(ev, db.done || {})}</div></section>` : ''}
    ${body}
  </div>`;
}

function moduleRow(course, m, isFresh) {
  const got = (f) => db.downloaded?.[`${f.url}|${f.time}`];
  let detail = moduleLabel(m.modname);
  if (m.files.length === 1 && m.files[0].size) detail += `, ${fmtSize(m.files[0].size)}`;
  if (m.files.length > 1) detail += `, ${m.files.length} files`;
  const folderFiles = m.modname === 'folder' && m.files.length
    ? `<ul class="files">${m.files.slice(0, 12).map((f, i) => `<li>${icon('resource', 14)}<span class="fname">${esc(f.path ? `${f.path}/` : '')}${esc(f.name)}</span>${f.size ? `<span class="faint">${fmtSize(f.size)}</span>` : ''}${got(f) ? `<span class="got" title="Downloaded">${icon('check', 14)}</span>` : ''}<button class="icon-btn" style="width:26px;height:26px" data-act="dl-file" data-mod="${m.id}" data-idx="${i}" aria-label="Download ${esc(f.name)}">${icon('download', 14)}</button></li>`).join('')}${m.files.length > 12 ? `<li class="faint">and ${m.files.length - 12} more</li>` : ''}</ul>`
    : '';
  const single = m.modname !== 'folder' && m.files.length;
  return `<li class="row${isFresh ? ' is-fresh' : ''}">
    ${modIcon(m.modname, course.id)}
    <div class="main">
      <a class="title" href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.name)}</a>
      <div class="sub">${isFresh ? '<span class="pill fresh">New</span>' : ''}${esc(detail)}${single && m.files.every(got) ? `<span class="got" style="color:var(--fresh)" title="Downloaded">${icon('check', 14)}</span>` : ''}</div>
      ${folderFiles}
    </div>
    <div class="end">
      ${single || m.modname === 'folder' && m.files.length ? `<button class="icon-btn" data-act="dl-mod" data-mod="${m.id}" title="Download" aria-label="Download ${esc(m.name)}">${icon('download', 17)}</button>` : ''}
      <a class="icon-btn hover-only" href="${esc(m.url)}" target="_blank" rel="noopener" title="Open in SCeLE" aria-label="Open ${esc(m.name)} in SCeLE">${icon('external', 16)}</a>
    </div>
  </li>`;
}

// ------------------------------------------------------------ inbox

function inboxPage() {
  const items = db.inbox?.items || [];
  return `<div class="page" style="max-width:820px">
    ${errorBanner()}
    <h1 class="headline" style="margin-bottom:22px">Inbox</h1>
    <h2>${unreadCount() ? `${unreadCount()} unread` : 'All caught up'}<span class="grow"></span>
      ${unreadCount() ? '<button class="btn small" data-act="read-all">Mark all as read</button>' : ''}
      <a class="btn small ghost" href="${esc(scele.urls.notifications)}" target="_blank" rel="noopener">${icon('external', 14)}Open on SCeLE</a></h2>
    <div class="panel"><ul class="rows">${items.length ? items.map(noteRow).join('') : `<li>${emptyNote('No notifications yet.', ' Announcements, forum replies and grading updates from SCeLE land here.')}</li>`}</ul></div>
  </div>`;
}

// ------------------------------------------------------------ grades

function gradesPage() {
  const list = db.grades?.list;
  if (!list) {
    return `<div class="page" style="max-width:820px"><h1 class="headline" style="margin-bottom:22px">Grades</h1><div class="skeleton" style="height:300px"></div></div>`;
  }
  const current = new Set(tracked().map((c) => c.id));
  const now_ = list.filter((g) => current.has(g.courseId));
  const past = list.filter((g) => !current.has(g.courseId));
  const block = (title, rows) => rows.length ? `<section class="section"><h2>${title} <span class="faint">${rows.length}</span></h2><div class="panel"><ul class="rows">${rows.map(gradeRow).join('')}</ul></div></section>` : '';
  return `<div class="page" style="max-width:820px">
    ${errorBanner()}
    <h1 class="headline" style="margin-bottom:22px">Grades</h1>
    ${list.length ? block('Courses you are taking', now_) + block('Other courses', past) : `<div class="panel">${emptyNote('No grades yet.', ' Grades show up here once your lecturers release them.')}</div>`}
    <p class="faint" style="font-size:var(--t-s)">Updated ${esc(rel(db.grades.at))}. Click a course to see every graded item.</p>
  </div>`;
}

function gradeRow(g) {
  const open = ui.gradeOpen.has(g.courseId);
  const c = courseById(g.courseId);
  const det = db.grades?.details?.[g.courseId];
  let detail = '';
  if (open) {
    if (!det && ui.gradeLoading.has(g.courseId)) detail = '<div class="grade-detail"><div class="skeleton" style="height:90px"></div></div>';
    else if (det) {
      detail = `<div class="grade-detail"><table><thead><tr><th>Item</th><th class="num">Grade</th><th class="num">Range</th><th class="num">%</th></tr></thead><tbody>
        ${det.items.map((it) => `<tr class="${it.kind === 'total' ? 'total' : ''}"><td>${esc(it.name)}</td><td class="num">${esc(it.grade)}</td><td class="num faint">${esc(it.range)}</td><td class="num">${esc(it.percent)}</td></tr>`).join('')}
      </tbody></table></div>`;
    } else detail = `<div class="grade-detail">${emptyNote("Couldn't load the grade breakdown.", '')}</div>`;
  }
  return `<li>
    <div class="row grade-row" role="button" tabindex="0" data-act="grade" data-id="${g.courseId}" aria-expanded="${open}">
      <span class="chev">${icon('chevron', 16)}</span>
      <span class="cdot" style="${hue(g.courseId)}"></span>
      <div class="main"><span class="title">${esc(c?.fullname || g.name)}</span>${c ? `<div class="sub">${esc(c.shortname)}</div>` : ''}</div>
      <span class="grade">${esc(g.grade)}</span>
    </div>
    ${detail}
  </li>`;
}

// ------------------------------------------------------------ settings

const REMINDER_CHOICES = [[168, '1 week'], [72, '3 days'], [24, '1 day'], [6, '6 hours'], [3, '3 hours'], [1, '1 hour']];
const TYPE_CHOICES = ['assign', 'quiz', 'forum', 'attendance', 'workshop', 'lesson', 'choice', 'feedback'];

function toggle(key, label, hint) {
  return `<div class="setting"><div class="label"><b>${label}</b><span>${hint}</span></div>
    <span class="toggle"><input type="checkbox" data-setting="${key}" ${settings[key] ? 'checked' : ''} aria-label="${label}"><span></span></span></div>`;
}

function settingsPage() {
  const isMac = /Mac/.test(navigator.platform);
  return `<div class="page settings">
    <h1 class="headline" style="margin-bottom:22px">Settings</h1>

    <h2>Courses</h2>
    <div class="panel setting-group">
      <div class="setting"><div class="label"><b>Courses I'm taking</b><span>${courses().length ? `Tracking ${tracked().length} of the ${courses().length} courses you're enrolled in.` : 'Your courses show up once Sceleton has synced.'} Courses you leave out won't show deadlines, reminders or alerts.</span></div>
        <button class="btn small" data-act="pick-courses" ${courses().length ? '' : 'disabled'}>Choose courses</button></div>
    </div>

    <h2>Reminders</h2>
    <div class="panel setting-group">
      <div class="setting"><div class="label"><b>Remind me before a deadline</b><span>Pick as many as you like. Reminders come as normal notifications.</span>
        <div class="chips-inline" style="margin-top:10px">${REMINDER_CHOICES.map(([h, l]) => `<button class="chip" data-act="reminder" data-h="${h}" aria-pressed="${settings.reminders.includes(h)}">${l}</button>`).join('')}</div></div></div>
      ${toggle('notifyMaterials', 'New course material', 'Get a notification when a lecturer adds slides, files or assignments.')}
      ${toggle('notifyInbox', 'SCeLE notifications', 'Announcements, forum replies and grading updates.')}
    </div>

    <h2>Toolbar and deadlines</h2>
    <div class="panel setting-group">
      <div class="setting"><div class="label"><b>Number on the toolbar icon</b><span>Counts deadlines you haven't ticked off.</span></div>
        <select data-setting="badge"><option value="24h" ${settings.badge === '24h' ? 'selected' : ''}>Due in 24 hours</option><option value="3d" ${settings.badge === '3d' ? 'selected' : ''}>Due in 3 days</option><option value="off" ${settings.badge === 'off' ? 'selected' : ''}>Don't show</option></select></div>
      <div class="setting"><div class="label"><b>Hide these kinds of deadlines</b><span>Useful for attendance and other things that aren't really work.</span>
        <div class="chips-inline" style="margin-top:10px">${TYPE_CHOICES.map((t) => `<button class="chip" data-act="hide-type" data-type="${t}" aria-pressed="${settings.hiddenTypes.includes(t)}">${moduleLabel(t)}</button>`).join('')}</div></div></div>
    </div>

    <h2>On the SCeLE website</h2>
    <div class="panel setting-group">
      ${toggle('darkScele', 'Dark mode for SCeLE', 'Makes scele.cs.ui.ac.id dark. Pictures stay close to their normal colours.')}
      ${toggle('countdown', 'Countdown on assignment pages', 'Shows a live timer in the corner of assignment and quiz pages.')}
    </div>

    <h2>Look and downloads</h2>
    <div class="panel setting-group">
      <div class="setting"><div class="label"><b>Theme</b><span>For Sceleton's own pages.</span></div>
        <select data-setting="theme"><option value="auto" ${settings.theme === 'auto' ? 'selected' : ''}>Match my computer</option><option value="light" ${settings.theme === 'light' ? 'selected' : ''}>Light</option><option value="dark" ${settings.theme === 'dark' ? 'selected' : ''}>Dark</option></select></div>
      <div class="setting"><div class="label"><b>Download folder</b><span>Inside your Downloads folder. Each course gets its own folder in here.</span></div>
        <input type="text" data-setting="downloadFolder" value="${esc(settings.downloadFolder)}" aria-label="Download folder"></div>
    </div>

    <h2>Account and data</h2>
    <div class="panel setting-group">
      <div class="setting"><div class="label"><b>${db.auth?.name ? esc(db.auth.name) : 'SCeLE account'}</b><span>${loggedOut() ? 'Not logged in.' : `Logged in through your browser. ${esc(syncedText())}.`}</span></div>
        <button class="btn small" data-act="sync">${icon('refresh', 15)}Sync now</button></div>
      <div class="setting"><div class="label"><b>Keyboard shortcuts</b><span>${isMac ? '⌘' : 'Ctrl'} K searches everything. Alt Shift S opens the popup, Alt Shift D opens this dashboard. Change them at ${isEdge ? 'edge' : 'chrome'}://extensions/shortcuts.</span></div></div>
      <div class="setting"><div class="label"><b>Clear saved data</b><span>Forgets deadlines, course pages, ticked off items and download history on this computer. Your settings stay.</span></div>
        <button class="btn small" data-act="clear-data">Clear</button></div>
    </div>
    <p class="faint" style="font-size:var(--t-s)">Sceleton ${chrome.runtime.getManifest().version}. Not made by or affiliated with Universitas Indonesia.</p>
  </div>`;
}

// ------------------------------------------------------------ render

let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  // Batch several changes into one redraw. (Not requestAnimationFrame: that
  // pauses in background tabs, and this page should stay current there too.)
  queueMicrotask(() => {
    renderQueued = false;
    $('#side').innerHTML = sidebar();
    const r = route();
    let html;
    if (r.page === 'settings') html = settingsPage();
    else if (loggedOut()) html = helloPage();
    else if (!db.auth && !db.events) html = loadingPage();
    else if (r.page === 'courses' && r.id) html = coursePage(r.id);
    else {
      const pages = { home: homePage, deadlines: deadlinesPage, courses: coursesPage, inbox: inboxPage, grades: gradesPage };
      html = (pages[r.page] || homePage)();
    }
    $('#main').innerHTML = html;
    if (ui.scrollTo) {
      document.getElementById(ui.scrollTo)?.scrollIntoView({ block: 'start' });
      ui.scrollTo = null;
    }
    const pageName = PAGES.find((p) => p[0] === r.page)?.[1];
    document.title = r.page === 'home' || !pageName ? 'Sceleton' : `Sceleton: ${pageName}`;
  });
}

function applyTheme() {
  const t = settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem('sceleton-theme', t); } catch (e) { /* ignore */ }
}

// ------------------------------------------------------------ loading data for a page

async function loadCourse(id, force = false) {
  const c = courseById(id);
  if (!c || ui.courseLoading.has(id)) return;
  const content = db.contents?.[id];
  if (!force && content && content.at > now() - 20 * 60) {
    captureFresh(id);
    return;
  }
  ui.courseLoading.add(id);
  render();
  try {
    const res = await chrome.runtime.sendMessage({ type: 'sync-course', id });
    if (res?.ok) delete ui.courseError[id];
    else ui.courseError[id] = res?.error || 'Something went wrong.';
  } catch (e) {
    ui.courseError[id] = e.message;
  }
  ui.courseLoading.delete(id);
  Object.assign(db, await store.getMany(['contents', 'fresh']));
  captureFresh(id);
  render();
}

// Remember what's new for this visit, then clear it so the badge goes away.
function captureFresh(id) {
  const list = db.fresh?.[id] || [];
  if (list.length) ui.freshShown[id] = list;
  if (list.length) data.markCourseSeen(id);
}

async function onRoute() {
  const r = route();
  if (loggedOut()) return;
  try {
    if (r.page === 'courses' && r.id) await loadCourse(r.id);
    else if (r.page === 'courses') {
      const stale = tracked().some((c) => !db.contents?.[c.id] || db.contents[c.id].at < now() - 2 * HOUR);
      if (stale) chrome.runtime.sendMessage({ type: 'refresh' }).catch(() => {});
    } else if (r.page === 'grades') {
      if (!db.grades?.at || db.grades.at < now() - HOUR) await data.syncGrades();
    } else if (r.page === 'inbox') {
      if (!db.inbox?.at || db.inbox.at < now() - 120) await data.syncInbox();
    }
  } catch (e) {
    console.warn('Sceleton:', e);
    if (r.page === 'grades' && !db.grades?.list) {
      await store.set('grades', { list: [], at: now(), error: e.message });
    }
  }
}

async function syncNow(force = false) {
  if (ui.syncing) return;
  ui.syncing = true;
  render();
  try {
    await chrome.runtime.sendMessage({ type: 'refresh', force });
  } catch (e) {
    console.warn('Sceleton: sync', e);
  }
  ui.syncing = false;
  render();
  onRoute();
}

// ------------------------------------------------------------ toast

let toastTimer;
function toast(msg, action) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action.label)}</button>` : ''}`;
  if (action) el.querySelector('button').onclick = () => { el.classList.remove('show'); action.run(); };
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? 7000 : 4000);
}

// ------------------------------------------------------------ downloads

async function download(files, label) {
  if (!files.length) return;
  const res = await chrome.runtime.sendMessage({ type: 'download', files });
  const n = res?.started || 0;
  const where = `Downloads/${safeName(settings.downloadFolder)}/${safeName(files[0].folder[0])}`;
  toast(n ? `Downloading ${n} ${n === 1 ? 'file' : 'files'}${label ? ` from ${label}` : ''} to ${where}` : "Couldn't start the download.");
}

function filesOf(courseId) {
  const c = courseById(courseId);
  const sections = db.contents?.[courseId]?.sections || [];
  return { c, sections, files: courseFiles(c, sections) };
}

// ------------------------------------------------------------ search palette

function searchIndex() {
  const items = [];
  for (const [key, label, ic] of PAGES) {
    items.push({ kind: 'Go to', title: label, icon: ic, run: () => { location.hash = `#/${key}`; } });
  }
  items.push({ kind: 'Action', title: 'Sync with SCeLE now', icon: 'refresh', run: () => syncNow(true) });
  items.push({ kind: 'Action', title: 'Choose which courses to track', icon: 'courses', run: openCoursePicker });
  items.push({ kind: 'Action', title: 'Add deadlines to calendar', sub: 'Downloads an .ics file', icon: 'calendar', run: exportIcs });
  items.push({ kind: 'Action', title: store.isDark(settings) ? 'Switch Sceleton to light mode' : 'Switch Sceleton to dark mode', icon: store.isDark(settings) ? 'sun' : 'moon', run: () => store.toggleTheme(settings) });
  items.push({ kind: 'Action', title: settings.darkScele ? 'Turn off dark mode for SCeLE' : 'Turn on dark mode for SCeLE', icon: 'moon', run: () => store.saveSettings({ darkScele: !settings.darkScele }) });
  for (const c of courses()) {
    items.push({ kind: 'Course', title: c.fullname, sub: c.shortname, courseId: c.id, icon: 'courses', run: () => { location.hash = `#/courses/${c.id}`; } });
    if (isHidden(c.id)) continue;
    for (const sec of db.contents?.[c.id]?.sections || []) {
      for (const m of sec.modules) {
        items.push({ kind: moduleLabel(m.modname), title: m.name, sub: `${c.shortname}, ${sec.name}`, courseId: c.id, mod: m.modname, run: () => window.open(m.url, '_blank') });
        if (m.modname === 'folder') {
          for (const f of m.files) items.push({ kind: 'File', title: f.name, sub: `${c.shortname}, ${m.name}`, courseId: c.id, mod: 'resource', run: () => window.open(m.url, '_blank') });
        }
      }
    }
  }
  for (const e of visible({ includeDone: true })) {
    items.push({ kind: 'Deadline', title: e.name, sub: `${e.course}, ${dayLabel(e.time)} ${fmtTime(e.time)}`, courseId: e.courseId, mod: e.modname, boost: 5, run: () => window.open(e.url, '_blank') });
  }
  for (const n of db.inbox?.items || []) {
    items.push({ kind: 'Inbox', title: n.subject, sub: rel(n.time), icon: 'inbox', run: () => window.open(n.url || scele.urls.notifications, '_blank') });
  }
  return items;
}

function openPalette() {
  if ($('.palette')) return;
  const index = searchIndex();
  let results = [];
  let sel = 0;
  const overlay = $('#overlay');
  overlay.innerHTML = `<div class="palette-backdrop" data-close>
    <div class="palette" role="dialog" aria-modal="true" aria-label="Search Sceleton">
      <div class="field">${icon('search', 20)}<input type="text" placeholder="Search courses, files, deadlines..." aria-label="Search" role="combobox" aria-expanded="true" aria-controls="pal-list" autocomplete="off" spellcheck="false"></div>
      <ul id="pal-list" role="listbox"></ul>
      <div class="hint"><span><kbd>↑</kbd> <kbd>↓</kbd> to move</span><span><kbd>Enter</kbd> to open</span><span><kbd>Esc</kbd> to close</span></div>
    </div></div>`;
  const input = overlay.querySelector('input');
  const list = overlay.querySelector('ul');
  const close = () => { overlay.innerHTML = ''; };

  const draw = () => {
    const q = input.value.trim();
    if (!q) {
      results = index.filter((i) => i.kind === 'Go to' || i.kind === 'Action').concat(index.filter((i) => i.kind === 'Deadline').slice(0, 5));
    } else {
      results = index
        .map((i) => ({ i, s: Math.max(fuzzy(q, i.title), fuzzy(q, i.sub || '') * 0.6) + (i.boost || 0) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 40)
        .map((x) => x.i);
    }
    sel = Math.min(sel, Math.max(0, results.length - 1));
    list.innerHTML = results.length ? results.map((r, i) => `
      <li role="option" id="pal-${i}" data-i="${i}" aria-selected="${i === sel}">
        <span class="mod-icon k-${esc(r.mod || '')}"${r.courseId ? ` style="${hue(r.courseId)}"` : ''}>${icon(r.icon || r.mod || 'other', 17)}</span>
        <span class="main"><span class="t">${esc(r.title)}</span>${r.sub ? `<span class="s">${esc(r.sub)}</span>` : ''}</span>
        <span class="k">${esc(r.kind)}</span>
      </li>`).join('') : `<li class="nothing" aria-disabled="true">No matches for "${esc(q)}". Course pages you haven't opened yet aren't searchable until Sceleton has loaded them.</li>`;
    input.setAttribute('aria-activedescendant', results.length ? `pal-${sel}` : '');
  };
  const pick = (i) => { const r = results[i]; if (!r) return; close(); r.run(); };

  input.addEventListener('input', () => { sel = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, results.length - 1); draw(); list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); draw(); list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); e.preventDefault(); }
    else if (e.key === 'Enter') { pick(sel); e.preventDefault(); }
    else if (e.key === 'Escape') { close(); e.preventDefault(); }
  });
  list.addEventListener('click', (e) => { const li = e.target.closest('li[data-i]'); if (li) pick(Number(li.dataset.i)); });
  overlay.querySelector('[data-close]').addEventListener('click', (e) => { if (e.target.hasAttribute('data-close')) close(); });
  draw();
  input.focus();
}

// ------------------------------------------------------------ course picker

function openCoursePicker() {
  const overlay = $('#overlay');
  const draw = () => {
    const list = courses();
    overlay.innerHTML = `<div class="palette-backdrop" data-close>
      <div class="palette picker" role="dialog" aria-modal="true" aria-labelledby="pick-title">
        <div class="picker-head">
          <h2 id="pick-title">Which courses are you taking?</h2>
          <p>Untick anything you only enrolled in to look around. Sceleton leaves those out of deadlines, the toolbar number, reminders and alerts.</p>
        </div>
        <ul class="pick-list">${list.map((c) => `<li><label>
          <span class="cdot" style="${hue(c.id)}"></span>
          <span class="main"><span class="t">${esc(c.fullname)}</span><span class="s">${esc(c.shortname)}</span></span>
          <span class="toggle"><input type="checkbox" data-pick="${c.id}" ${isHidden(c.id) ? '' : 'checked'} aria-label="Taking ${esc(c.fullname)}"><span></span></span>
        </label></li>`).join('')}</ul>
        <div class="picker-foot"><span class="faint">${tracked().length} of ${list.length} selected</span><span class="grow"></span><button class="btn primary" data-pick-done>Done</button></div>
      </div></div>`;
  };
  draw();
  const close = () => { overlay.innerHTML = ''; overlay.onchange = null; overlay.onclick = null; };
  overlay.onchange = async (e) => {
    const cid = Number(e.target.dataset.pick);
    if (!cid) return;
    const hidden = new Set(settings.hiddenCourses || []);
    if (e.target.checked) hidden.delete(cid); else hidden.add(cid);
    settings = await store.saveSettings({ hiddenCourses: [...hidden], coursesChosen: true });
    const foot = overlay.querySelector('.picker-foot .faint');
    if (foot) foot.textContent = `${tracked().length} of ${courses().length} selected`;
  };
  overlay.onclick = (e) => {
    if (e.target.hasAttribute('data-close') || e.target.closest('[data-pick-done]')) {
      close();
      store.saveSettings({ coursesChosen: true });
      chrome.runtime.sendMessage({ type: 'refresh' }).catch(() => {});
    }
  };
  overlay.querySelector('[data-pick-done]').focus();
}

// ------------------------------------------------------------ calendar export

function exportIcs() {
  const ev = visible().filter((e) => e.time > now());
  if (!ev.length) { toast('No upcoming deadlines to export.'); return; }
  const blob = new Blob([buildIcs(ev, settings.reminders.filter((h) => h <= 72))], { type: 'text/calendar' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'scele-deadlines.ics';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(`Saved ${ev.length} deadlines as scele-deadlines.ics. Open it to add them to your calendar.`);
}

// ------------------------------------------------------------ clicks and inputs

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const id = el.dataset.id ? Number(el.dataset.id) : null;

  if (act === 'search') openPalette();
  else if (act === 'pick-courses') openCoursePicker();
  else if (act === 'theme') settings = await store.toggleTheme(settings);
  else if (act === 'dismiss-pick') await store.saveSettings({ coursesChosen: true });
  else if (act === 'track') {
    await store.saveSettings({ hiddenCourses: (settings.hiddenCourses || []).filter((x) => x !== id), coursesChosen: true });
    toast(`Tracking ${courseById(id)?.shortname || 'this course'} again.`);
    chrome.runtime.sendMessage({ type: 'refresh' }).catch(() => {});
  }
  else if (act === 'sync') syncNow(true);
  else if (act === 'done') {
    e.preventDefault();
    await data.toggleDone(id);
  } else if (act === 'day') {
    ui.deadlineCourse = null;
    ui.scrollTo = el.dataset.day === 'late' ? 'd-overdue' : `d-${el.dataset.day}`;
    if (route().page === 'deadlines') render();
    else location.hash = '#/deadlines';
  } else if (act === 'filter-course') {
    ui.deadlineCourse = id || null;
    render();
  } else if (act === 'ics') exportIcs();
  else if (act === 'clear-fresh') {
    e.preventDefault();
    await store.set('fresh', {});
  } else if (act === 'note') {
    const n = (db.inbox?.items || []).find((x) => x.id === id);
    if (!n) return;
    window.open(n.url || scele.urls.notifications, '_blank');
    if (!isRead(n)) {
      ui.readLocally.add(id);
      render();
      try {
        await scele.markNotificationRead(id);
        await data.syncInbox();
      } catch (err) { console.warn('Sceleton:', err); }
    }
  } else if (act === 'read-all') {
    try {
      await scele.markAllNotificationsRead();
    } catch (err) {
      await Promise.all((db.inbox?.items || []).filter((n) => !n.read).map((n) => scele.markNotificationRead(n.id).catch(() => {})));
    }
    (db.inbox?.items || []).forEach((n) => ui.readLocally.add(n.id));
    render();
    await data.syncInbox().catch(() => {});
  } else if (act === 'grade') {
    if (ui.gradeOpen.has(id)) ui.gradeOpen.delete(id);
    else {
      ui.gradeOpen.add(id);
      if (!db.grades?.details?.[id]) {
        ui.gradeLoading.add(id);
        render();
        try { await data.syncCourseGrades(id); } catch (err) { console.warn(err); }
        ui.gradeLoading.delete(id);
      }
    }
    render();
  } else if (act === 'reload-course') loadCourse(id, true);
  else if (act === 'dl-course') {
    const { c, files } = filesOf(id);
    const todo = files.filter((f) => !db.downloaded?.[f.key]);
    if (todo.length) download(todo, c.shortname);
    else toast('Everything here is already downloaded.', { label: 'Download again', run: () => download(files, c.shortname) });
  } else if (act === 'dl-section') {
    const { c, sections } = filesOf(id);
    download(courseFiles(c, sections, Number(el.dataset.sec)), sections[Number(el.dataset.sec)]?.name);
  } else if (act === 'dl-mod' || act === 'dl-file') {
    const courseId = route().id;
    const { files } = filesOf(courseId);
    const mod = Number(el.dataset.mod);
    const picked = files.filter((f) => f.mod === mod && (act === 'dl-mod' || f.idx === Number(el.dataset.idx)));
    download(picked);
  } else if (act === 'reminder') {
    const h = Number(el.dataset.h);
    const r = settings.reminders.includes(h) ? settings.reminders.filter((x) => x !== h) : [...settings.reminders, h].sort((a, b) => b - a);
    await store.saveSettings({ reminders: r });
  } else if (act === 'hide-type') {
    const t = el.dataset.type;
    const hidden = settings.hiddenTypes.includes(t) ? settings.hiddenTypes.filter((x) => x !== t) : [...settings.hiddenTypes, t];
    await store.saveSettings({ hiddenTypes: hidden });
  } else if (act === 'clear-data') {
    if (!confirm('Clear everything Sceleton saved on this computer? Your settings stay.')) return;
    const keep = await store.getSettings();
    await chrome.storage.local.clear();
    await store.set('settings', keep);
    toast('Cleared. Syncing again...');
    syncNow(true);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('.picker')) { $('#overlay').innerHTML = ''; return; }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
  else if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) { e.preventDefault(); openPalette(); }
  else if ((e.key === 'Enter' || e.key === ' ') && document.activeElement?.dataset.act === 'grade') { e.preventDefault(); document.activeElement.click(); }
});

document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.dataset.act === 'show-done') { ui.showDone = el.checked; render(); return; }
  const key = el.dataset.setting;
  if (!key) return;
  const value = el.type === 'checkbox' ? el.checked : el.value.trim() || store.DEFAULT_SETTINGS[key];
  await store.saveSettings({ [key]: value });
  if (key === 'downloadFolder') toast(`Files will go to Downloads/${safeName(value)}`);
});

// ------------------------------------------------------------ start

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  const wasLoggedOut = loggedOut();
  for (const [k, v] of Object.entries(changes)) {
    if (v.newValue === undefined) delete db[k];
    else db[k] = v.newValue;
  }
  if (changes.settings) {
    settings = await store.getSettings();
    applyTheme();
  }
  render();
  if (wasLoggedOut && !loggedOut()) onRoute();
});

window.addEventListener('hashchange', () => {
  $('.palette-backdrop')?.remove();
  render();
  onRoute();
  window.scrollTo(0, 0);
});

(async function boot() {
  Object.assign(db, await chrome.storage.local.get(null));
  settings = await store.getSettings();
  applyTheme();
  render();
  onRoute();
  if (!db.events || db.events.at < now() - 5 * 60 || db.auth?.status !== 'ok') syncNow();
  setInterval(render, 60 * 1000); // keep countdowns ticking
})();
