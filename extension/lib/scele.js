// Talks to SCeLE using the login you already have in this browser.
//
// SCeLE is a Moodle site. When you're logged in, every page has a "sesskey"
// in it. With that key (and your browser's cookies) we can call the same
// JSON API that SCeLE's own pages use: /lib/ajax/service.php.
//
// Not every function is allowed through that API on every Moodle site, so
// the course page and grades also have a backup plan: read the normal HTML
// page and pick the data out of it. That needs DOMParser, which only exists
// in pages (popup, dashboard), not in the background worker.

import { SCELE_URL } from './config.js';
import { decode, cmidFromUrl, htmlToText } from './util.js';

export class NotLoggedIn extends Error {
  constructor() { super('Not logged in to SCeLE'); this.name = 'NotLoggedIn'; }
}
export class Unavailable extends Error {
  constructor(fn) { super(`${fn} is not available here`); this.name = 'Unavailable'; }
}

let session = null;

// How to turn an HTML page into data. Pages have DOMParser, so they parse
// directly. The background worker doesn't, so it plugs in a parser that asks
// a hidden "offscreen" page to do it (see background.js and offscreen/).
let htmlParser = typeof DOMParser !== 'undefined'
  ? async (kind, html) => PARSERS[kind](html)
  : null;
export function setHtmlParser(fn) { htmlParser = fn; }

async function get(path) {
  const r = await fetch(SCELE_URL + path, { credentials: 'include' });
  if (!r.ok) throw new Error(`SCeLE returned ${r.status} for ${path}`);
  if (/\/login\/index\.php/.test(r.url)) throw new NotLoggedIn();
  return r.text();
}

// Reads the sesskey and who you are from your SCeLE home page.
export function parseSession(html) {
  const key = html.match(/"sesskey"\s*:\s*"([^"]+)"/);
  if (!key) return null;
  const uid = html.match(/data-userid="(\d+)"/) || html.match(/user\/profile\.php\?id=(\d+)/);
  const name = html.match(/class="usertext[^"]*">\s*([^<]+?)\s*</)
    || html.match(/class="userinitials[^"]*"[^>]*title="([^"]+)"/)
    || html.match(/class="userpicture[^"]*"[^>]*alt="(?:Picture of |Gambar )?([^"]+)"/);
  return {
    sesskey: key[1],
    userid: uid ? Number(uid[1]) : 0,
    name: name ? decode(name[1]).trim() : '',
  };
}

export async function getSession(force = false) {
  if (session && !force) return session;
  const html = await get('/my/');
  const s = parseSession(html);
  if (!s) throw new NotLoggedIn();
  session = s;
  return s;
}

export async function call(methodname, args = {}, retry = true) {
  const s = await getSession();
  const r = await fetch(`${SCELE_URL}/lib/ajax/service.php?sesskey=${encodeURIComponent(s.sesskey)}&info=${methodname}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([{ index: 0, methodname, args }]),
  });
  if (!r.ok) throw new Error(`SCeLE returned ${r.status}`);
  const out = await r.json();
  const res = Array.isArray(out) ? out[0] : out;
  if (res && res.error) {
    const ex = res.exception || res;
    const code = ex.errorcode || '';
    if (['servicerequireslogin', 'invalidsesskey', 'requireloginerror', 'sitepolicynotagreed'].includes(code)) {
      session = null;
      if (retry) return call(methodname, args, false);
      throw new NotLoggedIn();
    }
    if (code === 'servicenotavailable' || /not available|tidak tersedia/i.test(ex.message || '')) {
      throw new Unavailable(methodname);
    }
    throw new Error(decode(ex.message) || code || 'SCeLE returned an error');
  }
  return res ? res.data : null;
}

// ------------------------------------------------------------ deadlines

function normalizeEvent(e) {
  const c = e.course || {};
  return {
    id: e.id,
    name: decode(e.activityname || e.name || ''),
    fullName: decode(e.name || ''),
    modname: e.modulename || e.eventtype || '',
    course: decode(c.shortname || c.fullname || ''),
    courseFull: decode(c.fullname || ''),
    courseId: c.id || e.courseid || 0,
    time: e.timesort,
    url: e.url || (e.action && e.action.url) || '',
    action: e.action ? decode(e.action.name || '') : '',
    cmid: cmidFromUrl(e.url),
  };
}

// Everything in your SCeLE timeline from `daysBack` ago to `daysAhead` from now.
export async function getEvents(daysAhead = 60, daysBack = 14) {
  const t = Math.floor(Date.now() / 1000);
  const all = [];
  let after = undefined;
  for (let page = 0; page < 10; page++) {
    const args = { timesortfrom: t - daysBack * 86400, timesortto: t + daysAhead * 86400, limitnum: 50 };
    if (after) args.aftereventid = after;
    const data = await call('core_calendar_get_action_events_by_timesort', args);
    const list = (data && data.events) || [];
    all.push(...list);
    if (list.length < 50) break;
    after = list[list.length - 1].id;
  }
  const seen = new Set();
  return all.map(normalizeEvent)
    .filter((e) => !seen.has(e.id) && seen.add(e.id))
    .sort((a, b) => a.time - b.time);
}

// ------------------------------------------------------------ courses

export async function getCourses() {
  const data = await call('core_course_get_enrolled_courses_by_timeline_classification', {
    classification: 'inprogress', limit: 0, offset: 0, sort: 'fullname',
  });
  return ((data && data.courses) || []).map((c) => ({
    id: c.id,
    shortname: decode(c.shortname || ''),
    fullname: decode(c.fullname || ''),
    url: c.viewurl || `${SCELE_URL}/course/view.php?id=${c.id}`,
    image: c.courseimage || '',
    progress: typeof c.progress === 'number' ? c.progress : null,
    category: decode(c.coursecategory || ''),
  }));
}

// ------------------------------------------------------------ course page

function fileUrl(u) {
  // The API hands out links meant for the mobile app. With browser cookies
  // the normal /pluginfile.php path is the one that works.
  return String(u || '').replace('/webservice/pluginfile.php', '/pluginfile.php');
}

function normalizeContents(sections) {
  return (sections || []).map((sec) => ({
    id: sec.id,
    name: decode(sec.name || '') || 'General',
    modules: (sec.modules || []).filter((m) => m.modname !== 'label').map((m) => ({
      id: m.id,
      name: decode(m.name || ''),
      modname: m.modname,
      url: m.url || '',
      files: (m.contents || []).filter((f) => f.type === 'file').map((f) => ({
        name: decode(f.filename || ''),
        path: (f.filepath || '/').replace(/^\/|\/$/g, ''),
        size: f.filesize || 0,
        url: fileUrl(f.fileurl),
        time: f.timemodified || 0,
        mime: f.mimetype || '',
      })),
    })),
  })).filter((s) => s.modules.length);
}

// Picks sections and activities out of a course page's HTML.
// Works with the Moodle 3.x and 4.x course page layouts.
export function parseCoursePage(html, baseUrl = SCELE_URL) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let sectionEls = [...doc.querySelectorAll('li.section, li[data-for="section"]')]
    .filter((el) => el.querySelector('li.activity'));
  sectionEls = sectionEls.filter((el) => !sectionEls.some((o) => o !== el && o.contains(el)));
  return sectionEls.map((sec, i) => {
    const title = sec.querySelector('.sectionname, [data-for="section_title"]');
    const modules = [...sec.querySelectorAll('li.activity')].map((li) => {
      const type = (li.className.match(/modtype_(\w+)/) || [])[1] || '';
      const link = li.querySelector('a.aalink, .activityname a, .activityinstance a, a[href*="/mod/"]');
      const inst = li.querySelector('.instancename');
      let name = '';
      if (inst) {
        const clone = inst.cloneNode(true);
        clone.querySelectorAll('.accesshide').forEach((n) => n.remove());
        name = clone.textContent.trim();
      } else if (link) {
        name = link.textContent.trim();
      }
      const id = Number((li.id.match(/module-(\d+)/) || [])[1] || li.dataset.id || 0);
      const url = link ? new URL(link.getAttribute('href'), baseUrl).href : '';
      const files = type === 'resource' && id
        ? [{ name: '', path: '', size: 0, url: `${baseUrl}/mod/resource/view.php?id=${id}&redirect=1`, time: 0, mime: '' }]
        : [];
      return { id, name, modname: type, url, files };
    }).filter((m) => m.id && m.modname !== 'label');
    const secId = Number((sec.id.match(/section-(\d+)/) || [])[1] ?? i);
    return { id: secId, name: title ? title.textContent.trim() : (i === 0 ? 'General' : `Section ${i}`), modules };
  }).filter((s) => s.modules.length);
}

// Returns { sections, via: 'api' | 'page' }
export async function getContents(courseId) {
  try {
    const data = await call('core_course_get_contents', { courseid: courseId });
    return { sections: normalizeContents(data), via: 'api' };
  } catch (e) {
    if (!(e instanceof Unavailable) || !htmlParser) throw e;
  }
  const html = await get(`/course/view.php?id=${courseId}`);
  return { sections: await htmlParser('course', html), via: 'page' };
}

// ------------------------------------------------------------ notifications (the bell icon)

export async function getNotifications(limit = 30) {
  const s = await getSession();
  const data = await call('message_popup_get_popup_notifications', {
    useridto: s.userid || 0, newestfirst: true, limit, offset: 0,
  });
  return {
    unread: data.unreadcount || 0,
    items: (data.notifications || []).map((n) => ({
      id: n.id,
      subject: decode(n.subject || n.shortenedsubject || ''),
      text: n.smallmessage || n.fullmessage || '',
      html: n.fullmessagehtml || '',
      url: n.contexturl || '',
      urlName: decode(n.contexturlname || ''),
      time: n.timecreated,
      read: !!n.read,
      component: n.component || '',
    })),
  };
}

export async function markNotificationRead(id) {
  return call('core_message_mark_notification_read', { notificationid: id, timeread: Math.floor(Date.now() / 1000) });
}

export async function markAllNotificationsRead() {
  const s = await getSession();
  return call('core_message_mark_all_notifications_as_read', { useridto: s.userid || 0 });
}

// ------------------------------------------------------------ announcements and activity text

// The course's "Announcements" forum, newest first. Only works when the site
// lets the forum API through; otherwise this throws Unavailable.
export async function getAnnouncements(courseId, limit = 15) {
  const forums = await call('mod_forum_get_forums_by_courses', { courseids: [courseId] });
  const news = (forums || []).find((f) => f.type === 'news');
  if (!news) return [];
  const res = await call('mod_forum_get_forum_discussions', { forumid: news.id, sortorder: -1, page: 0, perpage: limit });
  return ((res && res.discussions) || []).map((d) => {
    const id = d.discussion || d.id;
    return {
      id,
      title: decode(d.subject || d.name || ''),
      author: decode(d.userfullname || ''),
      time: d.timemodified || d.created || 0,
      text: htmlToText(d.message || ''),
      url: `${SCELE_URL}/mod/forum/discuss.php?d=${id}`,
    };
  });
}

// Backup for sites that block the forum API: open the Announcements page like
// a person would, then each post. `sections` is the course's saved contents,
// used to find the Announcements forum.
export async function getAnnouncementsFromPages(sections, limit = 15) {
  const forums = (sections || []).flatMap((s) => s.modules).filter((m) => m.modname === 'forum' && m.url);
  const news = forums.find((m) => /announce|pengumuman|news|berita/i.test(m.name)) || forums[0];
  if (!news) throw new Error('no Announcements forum on the course page');
  const parse = (html) => new DOMParser().parseFromString(html, 'text/html');
  const list = parse(await get(news.url.replace(SCELE_URL, '')));
  const seen = new Map();
  for (const a of list.querySelectorAll('a[href*="discuss.php?d="]')) {
    const d = (a.getAttribute('href').match(/[?&]d=(\d+)/) || [])[1];
    const title = a.textContent.replace(/\s+/g, ' ').trim();
    if (d && title && !seen.has(d)) seen.set(d, title);
  }
  if (!seen.size) return [];
  const out = [];
  await Promise.all([...seen].slice(0, limit).map(async ([d, title], i) => {
    try {
      const doc = parse(await get(`/mod/forum/discuss.php?d=${d}`));
      doc.querySelectorAll('script, style, .accesshide, .sr-only').forEach((n) => n.remove());
      const body = doc.querySelector('.forum-post-container .post-content-container, .forumpost .posting, .posting');
      const when = doc.querySelector('time[datetime]')?.getAttribute('datetime');
      const author = doc.querySelector('.forum-post-container .author-info a, .forumpost .author a, .author a');
      out[i] = {
        id: Number(d), title: decode(title), author: author ? author.textContent.trim() : '',
        time: when ? Math.floor(new Date(when).getTime() / 1000) || 0 : 0,
        text: body ? htmlToText(body.innerHTML) : '', url: `${SCELE_URL}/mod/forum/discuss.php?d=${d}`,
      };
    } catch (e) {
      if (e instanceof NotLoggedIn) throw e;
    }
  }));
  return out.filter(Boolean);
}

// The written description on an assignment page ('assign') or the body of a
// "Page" activity ('page'). Needs DOMParser, so it runs in the dashboard.
export async function getActivityText(url, kind = 'assign') {
  const doc = new DOMParser().parseFromString(await get(String(url).replace(SCELE_URL, '')), 'text/html');
  doc.querySelectorAll('script, style, .accesshide, .sr-only, .visually-hidden').forEach((n) => n.remove());
  const where = kind === 'page'
    ? ['.box.generalbox .no-overflow', '.generalbox', '[role="main"]']
    : ['#intro', '[data-region="activity-description"]', '.activity-description'];
  for (const sel of where) {
    const el = doc.querySelector(sel);
    const text = el ? htmlToText(el.innerHTML) : '';
    if (text) return text;
  }
  return '';
}

// ------------------------------------------------------------ grades

function cellText(el) {
  if (!el) return '';
  const clone = el.cloneNode(true);
  clone.querySelectorAll('.accesshide, .sr-only, .visually-hidden, .action-menu').forEach((n) => n.remove());
  return clone.textContent.replace(/\s+/g, ' ').trim();
}

export function parseGradeOverview(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const rows = doc.querySelectorAll('#overview-grade tr, table.generaltable tbody tr');
  const out = [];
  for (const tr of rows) {
    const a = tr.querySelector('a[href*="id="]');
    const cells = tr.querySelectorAll('td');
    if (!a || cells.length < 2) continue;
    const id = Number((a.getAttribute('href').match(/[?&]id=(\d+)/) || [])[1]);
    if (!id || out.some((g) => g.courseId === id)) continue;
    out.push({ courseId: id, name: cellText(a), grade: cellText(cells[1]) || '-' });
  }
  return out;
}

export function parseUserReport(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = [];
  for (const tr of doc.querySelectorAll('table.user-grade tr')) {
    const nameEl = tr.querySelector('th.column-itemname, td.column-itemname');
    if (!nameEl) continue;
    const name = cellText(nameEl);
    if (!name) continue;
    const isTotal = nameEl.classList.contains('category') || /total/i.test(name) || tr.classList.contains('categoryitem');
    out.push({
      name,
      grade: cellText(tr.querySelector('.column-grade')) || '-',
      range: cellText(tr.querySelector('.column-range')),
      percent: cellText(tr.querySelector('.column-percentage')),
      feedback: cellText(tr.querySelector('.column-feedback')),
      kind: isTotal ? 'total' : 'item',
    });
  }
  return out;
}

export async function getGradeOverview() {
  try {
    const data = await call('gradereport_overview_get_course_grades');
    return (data.grades || []).map((g) => ({ courseId: g.courseid, name: '', grade: g.grade || '-' }));
  } catch (e) {
    if (!(e instanceof Unavailable) || !htmlParser) throw e;
  }
  return htmlParser('gradeOverview', await get('/grade/report/overview/index.php'));
}

export async function getCourseGrades(courseId) {
  try {
    const s = await getSession();
    const data = await call('gradereport_user_get_grade_items', { courseid: courseId, userid: s.userid });
    const items = (data.usergrades && data.usergrades[0] && data.usergrades[0].gradeitems) || [];
    return items.map((it) => ({
      name: decode(it.itemname || (it.itemtype === 'course' ? 'Course total' : 'Category total')),
      grade: it.gradeformatted || '-',
      range: it.rangeformatted || '',
      percent: it.percentageformatted || '',
      feedback: it.feedback ? decode(it.feedback.replace(/<[^>]+>/g, '')) : '',
      kind: it.itemtype === 'course' || it.itemtype === 'category' ? 'total' : 'item',
    }));
  } catch (e) {
    if (!(e instanceof Unavailable) || !htmlParser) throw e;
  }
  return htmlParser('userReport', await get(`/grade/report/user/index.php?id=${courseId}`));
}

export const PARSERS = {
  course: (html) => parseCoursePage(html),
  gradeOverview: parseGradeOverview,
  userReport: parseUserReport,
};

export const urls = {
  home: `${SCELE_URL}/my/`,
  login: `${SCELE_URL}/login/index.php`,
  course: (id) => `${SCELE_URL}/course/view.php?id=${id}`,
  grades: (id) => `${SCELE_URL}/grade/report/user/index.php?id=${id}`,
  notifications: `${SCELE_URL}/message/output/popup/notifications.php`,
};
