// Packs a course (or your whole semester) into something you can hand to Claude.
//
// The dashboard calls three things here, in this order:
//   1. collectCourse()   reads the extra stuff SCeLE has (grades, announcements,
//                        assignment descriptions) on top of what Sceleton saved already
//   2. fetchFiles()      downloads the course files, only for the .zip option
//   3. renderContext()   writes it all up as one markdown file
//
// Nothing here sends your data anywhere. It builds files on your computer and
// you decide what to paste or upload.

import * as scele from './scele.js';
import * as data from './data.js';
import { makeZip } from './zip.js';
import { now, rel, safeName, fmtSize, moduleLabel, DAY } from './util.js';

const stampFmt = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
});
const dayFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const when = (ts) => stampFmt.format(ts * 1000);
const dayOnly = (ts) => dayFmt.format(ts * 1000);

export const wordCount = (text) => (text.trim() ? text.trim().split(/\s+/).length : 0);

// Every downloadable file in a course, with the folder it belongs in.
// (The dashboard's "Download all" button uses the same list.)
export function courseFiles(course, sections, onlySection = null) {
  const out = [];
  sections.forEach((sec, si) => {
    if (onlySection !== null && si !== onlySection) return;
    for (const m of sec.modules) {
      m.files.forEach((f, fi) => {
        const folder = [course.shortname, sec.name];
        if (m.modname === 'folder') folder.push(m.name, ...f.path.split('/').filter(Boolean));
        out.push({ url: f.url, name: f.name, size: f.size || 0, folder, key: `${f.url}|${f.time}`, mod: m.id, idx: fi });
      });
    }
  });
  return out;
}

// ------------------------------------------------------------ 1. gathering

async function pool(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  }));
}

export async function collectCourse(course, { db, settings, details = true, onProgress = () => {} }) {
  const id = course.id;
  const sections = db.contents?.[id]?.sections || [];
  const model = {
    course, sections, at: now(), notes: [],
    events: (db.events?.list || []).filter((e) => e.courseId === id && !settings.hiddenTypes.includes(e.modname)),
    done: db.done || {},
    grades: null, total: '', announcements: null, briefs: {}, pages: {}, notifications: [],
  };

  onProgress({ label: 'Reading your grades' });
  try {
    model.grades = await data.syncCourseGrades(id);
    const totals = model.grades.filter((g) => g.kind === 'total');
    model.total = (totals[totals.length - 1] || {}).grade || '';
  } catch (e) {
    if (e instanceof scele.NotLoggedIn) throw e;
    model.notes.push("Grades couldn't be read, so they are left out.");
  }
  if (!model.total) model.total = (db.grades?.list || []).find((g) => g.courseId === id)?.grade || '';

  onProgress({ label: 'Reading announcements' });
  try {
    model.announcements = await scele.getAnnouncements(id, 15);
  } catch (e) {
    if (e instanceof scele.NotLoggedIn) throw e;
    model.notes.push("Announcements couldn't be read on this SCeLE, so they are left out.");
  }
  if (!model.announcements?.length) {
    const short = course.shortname.toLowerCase();
    model.notifications = (db.inbox?.items || [])
      .filter((n) => `${n.subject} ${n.text}`.toLowerCase().includes(short)).slice(0, 10);
  }

  if (details) {
    const t = now();
    const assigns = model.events
      .filter((e) => e.modname === 'assign' && e.url)
      .sort((a, b) => Math.abs(a.time - t) - Math.abs(b.time - t))
      .slice(0, 15)
      .map((e) => ({ kind: 'assign', key: e.id, url: e.url }));
    const pages = sections.flatMap((s) => s.modules).filter((m) => m.modname === 'page' && m.url).slice(0, 25)
      .map((m) => ({ kind: 'page', key: m.id, url: m.url }));
    const todo = [...assigns, ...pages];
    let done = 0;
    await pool(todo, 3, async (w) => {
      try {
        const text = await scele.getActivityText(w.url, w.kind);
        if (text) (w.kind === 'assign' ? model.briefs : model.pages)[w.key] = text;
      } catch (e) {
        if (e instanceof scele.NotLoggedIn) throw e;
      }
      onProgress({ label: 'Reading assignment descriptions and pages', done: ++done, total: todo.length });
    });
  }
  return model;
}

// ------------------------------------------------------------ 2. files for the zip

function nameFromResponse(r, fallback) {
  const cd = r.headers.get('content-disposition') || '';
  const m = cd.match(/filename\*=(?:UTF-8'')?([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
  if (m) {
    const raw = m[1].trim().replace(/^"|"$/g, '');
    try { return decodeURIComponent(raw); } catch (e) { return raw; }
  }
  try { return decodeURIComponent(new URL(r.url).pathname.split('/').pop()) || fallback; } catch (e) { return fallback; }
}

// Downloads every file of the course into memory.
// Returns { entries, paths, skipped }. `paths` maps "moduleId:index" to the
// path inside the zip, so context.md can point at the right file.
export async function fetchFiles(course, sections, { onProgress = () => {}, maxEach = 120e6, maxTotal = 450e6 } = {}) {
  const plan = courseFiles(course, sections);
  const entries = [];
  const paths = new Map();
  const skipped = [];
  let total = 0;
  let done = 0;

  await pool(plan, 3, async (f) => {
    const label = f.name || 'file';
    try {
      if (f.size > maxEach) { skipped.push({ name: label, why: `bigger than ${fmtSize(maxEach)}` }); return; }
      if (total + f.size > maxTotal) { skipped.push({ name: label, why: 'the zip would get too big' }); return; }
      const r = await fetch(f.url, { credentials: 'include' });
      if (!r.ok) throw new Error(`status ${r.status}`);
      if (/\/login\/index\.php/.test(r.url)) throw new scele.NotLoggedIn();
      const bytes = new Uint8Array(await r.arrayBuffer());
      if (bytes.length > maxEach || total + bytes.length > maxTotal) {
        skipped.push({ name: label, why: 'too big to fit in the zip' });
        return;
      }
      total += bytes.length;
      const name = safeName(f.name || nameFromResponse(r, 'file'));
      const dir = f.folder.slice(1).map(safeName).join('/');
      const path = `files/${dir ? `${dir}/` : ''}${name}`;
      entries.push({ name: path, data: bytes });
      paths.set(`${f.mod}:${f.idx}`, path);
    } catch (e) {
      if (e instanceof scele.NotLoggedIn) throw e;
      skipped.push({ name: label, why: "couldn't be downloaded" });
    } finally {
      onProgress({ label: 'Downloading course files', done: ++done, total: plan.length });
    }
  });
  return { entries, paths, skipped, count: plan.length };
}

// ------------------------------------------------------------ 3. writing it up

function bullet(text) { return `- ${text}`; }

function deadlineLine(e, done) {
  const parts = [`**${e.name}** (${moduleLabel(e.modname) || 'Activity'}), due ${when(e.time)}`];
  if (e.time >= now()) parts.push(`(${rel(e.time)})`);
  if (done[e.id]) parts.push('(I ticked this off)');
  if (e.url) parts.push(`<${e.url}>`);
  return bullet(parts.join(' '));
}

export function renderContext(m, { paths = null, skipped = [] } = {}) {
  const c = m.course;
  const t = now();
  const L = [];
  L.push(`# ${c.fullname}`, '');
  L.push(`- Course code: ${c.shortname}`);
  L.push(`- SCeLE page: <${c.url}>`);
  L.push(`- Exported from SCeLE with Sceleton on ${when(m.at)}`);
  if (m.total) L.push(`- My grade so far: ${m.total}`);
  L.push('', 'This is my own course material and progress, copied from SCeLE. Use it as background when you help me study, plan my work or understand the course. If something I ask about is not here, say so instead of guessing dates or grades.', '');

  const upcoming = m.events.filter((e) => e.time >= t).sort((a, b) => a.time - b.time);
  const recent = m.events.filter((e) => e.time < t).sort((a, b) => b.time - a.time);
  L.push('## Deadlines', '');
  if (!upcoming.length && !recent.length) L.push('SCeLE shows no deadlines for this course right now.', '');
  if (upcoming.length) L.push('### Coming up', '', ...upcoming.map((e) => deadlineLine(e, m.done)), '');
  if (recent.length) L.push('### Recently passed (last 14 days)', '', ...recent.map((e) => deadlineLine(e, m.done)), '');

  const briefEvents = m.events.filter((e) => m.briefs[e.id]);
  if (briefEvents.length) {
    L.push('## Assignment descriptions', '', 'Copied from each assignment page on SCeLE.', '');
    for (const e of briefEvents) L.push(`### ${e.name}`, '', `Due ${when(e.time)}`, '', m.briefs[e.id], '');
  }

  if (m.grades) {
    L.push('## Grades', '');
    if (!m.grades.length) L.push('No grades are posted yet.', '');
    else {
      L.push('| Item | Grade | Range | Percent | Feedback |', '| --- | --- | --- | --- | --- |');
      for (const g of m.grades) {
        const cell = (s) => String(s || '').replace(/\|/g, '/').replace(/\s+/g, ' ');
        L.push(`| ${g.kind === 'total' ? `**${cell(g.name)}**` : cell(g.name)} | ${cell(g.grade)} | ${cell(g.range)} | ${cell(g.percent)} | ${cell(g.feedback)} |`);
      }
      L.push('');
    }
  }

  if (m.announcements?.length) {
    L.push('## Announcements', '', 'Newest first.', '');
    for (const a of m.announcements) {
      L.push(`### ${a.title}`, '', `${dayOnly(a.time)}${a.author ? `, ${a.author}` : ''}`, '', a.text, '');
    }
  } else if (m.notifications.length) {
    L.push('## Recent SCeLE notifications that mention this course', '');
    for (const n of m.notifications) L.push(`### ${n.subject}`, '', dayOnly(n.time), '', String(n.text).replace(/<[^>]+>/g, '').trim(), '');
  }

  L.push('## Course material', '');
  if (!m.sections.length) L.push('Nothing has been posted on the course page yet.', '');
  for (const sec of m.sections) {
    L.push(`### ${sec.name}`, '');
    for (const mod of sec.modules) {
      const label = moduleLabel(mod.modname) || 'Item';
      if (mod.modname === 'folder' && mod.files.length) {
        L.push(bullet(`${label}: ${mod.name}`));
        mod.files.forEach((f, i) => {
          const p = paths?.get(`${mod.id}:${i}`);
          L.push(`  - ${f.path ? `${f.path}/` : ''}${f.name}${f.size ? ` (${fmtSize(f.size)})` : ''}${p ? `, saved as \`${p}\`` : ''}`);
        });
      } else if (mod.files.length) {
        const f = mod.files[0];
        const p = paths?.get(`${mod.id}:0`);
        L.push(bullet(`${label}: ${mod.name}${f.size ? ` (${fmtSize(f.size)})` : ''}${p ? `, saved as \`${p}\`` : ''}${!p && mod.url ? ` <${mod.url}>` : ''}`));
      } else {
        L.push(bullet(`${label}: ${mod.name}${mod.url ? ` <${mod.url}>` : ''}`));
      }
    }
    L.push('');
  }

  const pageIds = Object.keys(m.pages);
  if (pageIds.length) {
    L.push('## Text of course pages', '');
    for (const mod of m.sections.flatMap((s) => s.modules).filter((x) => m.pages[x.id])) {
      L.push(`### ${mod.name}`, '', m.pages[mod.id], '');
    }
  }

  if (skipped.length) {
    L.push('## Files not included in the zip', '', ...skipped.map((s) => bullet(`${s.name}: ${s.why}`)), '');
  }
  if (m.notes.length) L.push('## Notes from the export', '', ...m.notes.map(bullet), '');

  return L.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

// The whole semester in one page: what's due and how you're doing in each course.
export function renderSemester({ courses, db, settings }) {
  const t = now();
  const L = ['# My semester so far', '', `Exported from SCeLE with Sceleton on ${when(t)}.`, '',
    'These are the courses I am actually taking, with my grade so far and what is due next. Use it as background when you help me plan my time.', ''];
  const events = (db.events?.list || []).filter((e) => !settings.hiddenTypes.includes(e.modname));
  const ids = new Set(courses.map((c) => c.id));
  const next = events.filter((e) => ids.has(e.courseId) && e.time >= t && e.time < t + 30 * DAY && !(db.done || {})[e.id]).sort((a, b) => a.time - b.time);

  L.push('## Due in the next 30 days', '');
  L.push(...(next.length ? next.map((e) => bullet(`**${e.name}** (${e.course}), ${when(e.time)}, ${rel(e.time)}`)) : ['Nothing is due.']), '');

  L.push('## Courses', '');
  for (const c of courses) {
    const grade = (db.grades?.list || []).find((g) => g.courseId === c.id)?.grade;
    const mine = events.filter((e) => e.courseId === c.id && e.time >= t).sort((a, b) => a.time - b.time).slice(0, 5);
    L.push(`### ${c.fullname} (${c.shortname})`, '', bullet(`Grade so far: ${grade && grade !== '-' ? grade : 'not posted yet'}`));
    L.push(bullet(mine.length ? `Next: ${mine.map((e) => `${e.name} (${dayOnly(e.time)})`).join('; ')}` : 'Next: nothing due'), '');
  }
  return L.join('\n').trimEnd() + '\n';
}

// ------------------------------------------------------------ 4. the zip

// A short file that tells Claude Code what this folder is. Claude Code reads
// CLAUDE.md on its own when you start it in the folder.
export function claudeMdFor(course, at) {
  return `# ${course.shortname}: ${course.fullname}

This folder is one of my university courses, exported from SCeLE with Sceleton on ${dayOnly(at)}.

- Read @context.md first. It has my deadlines, grades, announcements and a list of all course material.
- The lecture slides and other files are in \`files/\`.
- If something is not in context.md, say so instead of guessing a date or a grade.
`;
}

export function buildZip({ course, markdown, at, files }) {
  const root = safeName(course.shortname);
  return makeZip([
    { name: `${root}/CLAUDE.md`, data: claudeMdFor(course, at) },
    { name: `${root}/context.md`, data: markdown },
    ...files.map((f) => ({ name: `${root}/${f.name}`, data: f.data })),
  ]);
}
