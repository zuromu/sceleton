// "Save everything": an offline copy of a whole course.
//
// Files are downloaded like the "Download all" button does. Everything else
// on the course page (quizzes and exams you finished, your assignment
// submissions and feedback, pages, books, forums, links) is saved as a
// readable .html snapshot, with its pictures and attachments next to it.
// Last, an index.html lists it all, so the course folder works offline.
//
// Safety: this only ever READS. It opens pages SCeLE shows you anyway, and
// never anything that starts, continues or submits an attempt. Opening a
// quiz attempt page can start the timer on an exam, so those addresses are
// refused below, whatever a page links to.
//
// Needs DOMParser, so it runs in the dashboard.

import { SCELE_URL } from './config.js';
import { NotLoggedIn } from './scele.js';
import { esc, safeName, moduleLabel, now, htmlToText } from './util.js';

// Never opened, even if a page links to it.
const FORBIDDEN = /\/mod\/quiz\/(startattempt|attempt|processattempt|summary|autosave)\.php|\/mod\/lesson\/(continue|view\.php\?[^#]*pageid)|\/mod\/(assign|choice|feedback|workshop|data)\/[^?]*\?[^#]*(action=|sesskey=)|sesskey=|\/login\/logout\.php/i;

export function isForbidden(url) {
  return FORBIDDEN.test(String(url));
}

const local = (u) => String(u).replace(SCELE_URL, '');

async function getHtml(url) {
  if (isForbidden(url)) throw new Error(`refused to open ${url}`);
  const r = await fetch(SCELE_URL + local(url), { credentials: 'include' });
  if (/\/login\/index\.php/.test(r.url)) throw new NotLoggedIn();
  if (!r.ok) throw new Error(`SCeLE returned ${r.status}`);
  return new DOMParser().parseFromString(await r.text(), 'text/html');
}

async function pool(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  }));
}

function blobToDataUrl(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(blob);
  });
}

// The file name in a pluginfile.php address: /pluginfile.php/1/mod_x/area/0/Name.pdf?forcedownload=1
export function pluginfileName(url) {
  try {
    const last = new URL(url, SCELE_URL).pathname.split('/').pop();
    return decodeURIComponent(last) || 'file';
  } catch (e) {
    return 'file';
  }
}

const isPluginfile = (href) => /\/pluginfile\.php\//.test(href);

// ------------------------------------------------------------ snapshots

const PAGE_CSS = `
:root{color-scheme:light dark;--ink:#1d2125;--ink2:#5c6670;--line:#dee2e6;--bg:#fff;--soft:#f5f6f8;--ok:#1a7f37;--bad:#c62828;--part:#b26a00}
@media (prefers-color-scheme:dark){:root{--ink:#e8eaed;--ink2:#a5adb5;--line:#3a3f45;--bg:#17191c;--soft:#22262a}}
body{font:16px/1.55 -apple-system,"Segoe UI",Roboto,sans-serif;margin:0;background:var(--bg);color:var(--ink)}
.sc-head{border-bottom:1px solid var(--line);padding:14px 24px;font-size:14px;color:var(--ink2);display:flex;flex-wrap:wrap;gap:6px 18px}
.sc-head b{color:var(--ink)} .sc-head a{color:inherit}
.sc-main{max-width:900px;margin:0 auto;padding:24px}
img{max-width:100%;height:auto} table{border-collapse:collapse;max-width:100%} td,th{border:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}
pre,code{background:var(--soft);border-radius:4px} pre{padding:10px;overflow:auto}
.que{border:1px solid var(--line);border-radius:10px;padding:14px 18px;margin:18px 0}
.que .info{display:flex;gap:14px;align-items:baseline;flex-wrap:wrap;font-size:14px;color:var(--ink2);margin-bottom:8px}
.que .info h3{margin:0;font-size:16px;color:var(--ink)}
.que.correct{border-left:5px solid var(--ok)} .que.incorrect{border-left:5px solid var(--bad)} .que.partiallycorrect{border-left:5px solid var(--part)}
.que .answer>div{display:flex;gap:8px;align-items:flex-start;padding:3px 0} .que .answer .d-flex{display:flex;gap:4px}
.que .outcome{background:var(--soft);border-radius:8px;padding:10px 14px;margin-top:10px}
.rightanswer{font-weight:600}
.que .answer>div:has(input[checked]){background:var(--soft);border-radius:6px;font-weight:600}
.que .answer>div:has(input[checked])::after{content:"my answer";margin-left:auto;padding-right:8px;font-size:12px;font-weight:400;color:var(--ink2)}
.sc-gone{color:var(--ink2);font-style:italic}
`;

function pageShell({ title, course, source, body, at = now() }) {
  const when = new Date(at * 1000).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${PAGE_CSS}</style></head><body>
<div class="sc-head"><span><b>${esc(title)}</b></span><span>${esc(course)}</span><span>Saved ${esc(when)} with Sceleton</span>${source ? `<a href="${esc(source)}">Open on SCeLE</a>` : ''}</div>
<div class="sc-main">${body}</div></body></html>`;
}

// Turns a SCeLE page into a self-contained copy.
// `dir` is the folder (relative to the snapshot) where attachments go.
// Returns { html, text, attachments: [{ url, path }] } where path is relative to the snapshot.
export async function snapshot(doc, { title, course, source, dir, pick = null }) {
  const main = (pick && doc.querySelector(pick)) || doc.querySelector('#region-main [role="main"], [role="main"], #region-main, main') || doc.body;
  const root = main.cloneNode(true);
  root.querySelectorAll('script, style, noscript, iframe, link, .accesshide, .sr-only, .visually-hidden, .skip-links, [data-region="drawer"], .modal, .action-menu, .editing_move, input[type="hidden"], input[type="submit"], button')
    .forEach((n) => n.remove());
  root.querySelectorAll('form').forEach((f) => { const d = doc.createElement('div'); d.append(...f.childNodes); f.replaceWith(d); });
  root.querySelectorAll('input, select, textarea').forEach((n) => n.setAttribute('disabled', ''));
  root.querySelectorAll('*').forEach((n) => {
    for (const a of [...n.attributes]) if (/^on/i.test(a.name)) n.removeAttribute(a.name);
  });

  // Pictures go inside the page itself, so it is one file you can move around.
  await pool([...root.querySelectorAll('img[src]')], 4, async (img) => {
    const src = img.getAttribute('src');
    if (src.startsWith('data:')) return;
    let abs;
    try { abs = new URL(src, SCELE_URL).href; } catch (e) { img.remove(); return; }
    if (!abs.startsWith(SCELE_URL) || isForbidden(abs)) { img.setAttribute('src', abs); return; }
    try {
      const r = await fetch(abs, { credentials: 'include' });
      const blob = await r.blob();
      if (!r.ok || blob.size > 4e6 || /\/login\/index\.php/.test(r.url)) throw new Error('skip');
      img.setAttribute('src', await blobToDataUrl(blob));
      img.removeAttribute('srcset');
    } catch (e) {
      img.setAttribute('src', abs);
    }
  });

  // Attachments (lecturer files, your submission, feedback files) are saved
  // next to the page, and the link points at the saved copy.
  const attachments = [];
  const used = new Map();
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    let abs;
    try { abs = new URL(href, SCELE_URL).href; } catch (e) { continue; }
    if (abs.startsWith(SCELE_URL) && isPluginfile(abs) && !isForbidden(abs)) {
      const clean = abs.replace(/[?&]forcedownload=1/, '');
      let path = used.get(clean);
      if (!path) {
        const name = safeName(pluginfileName(clean));
        path = `${dir}/${name}`;
        if ([...used.values()].includes(path)) path = `${dir}/${attachments.length + 1} ${name}`;
        used.set(clean, path);
        attachments.push({ url: clean, path });
      }
      a.setAttribute('href', encodeURI(path));
    } else {
      a.setAttribute('href', abs);
    }
  }
  const body = root.innerHTML;
  return { html: pageShell({ title, course, source, body }), text: htmlToText(body), attachments };
}

// ------------------------------------------------------------ quizzes

// The finished attempts listed on a quiz page: [{ id, url, label }].
// Only attempts with a Review link; the rest have review closed by the lecturer.
export function quizAttempts(doc) {
  const out = [];
  const seen = new Set();
  for (const a of doc.querySelectorAll('a[href*="/mod/quiz/review.php"]')) {
    const u = new URL(a.getAttribute('href'), SCELE_URL);
    const id = Number(u.searchParams.get('attempt'));
    if (!id || seen.has(id)) continue;
    seen.add(id);
    u.searchParams.set('showall', '1'); // every question on one page
    out.push({ id, url: u.href, label: `Attempt ${out.length + 1}` });
  }
  return out;
}

// A quiz review as plain text, for the Claude export.
export function quizText(doc) {
  const L = [];
  for (const q of doc.querySelectorAll('.que')) {
    const t = (sel) => htmlToText(q.querySelector(sel)?.innerHTML || '');
    const no = q.querySelector('.qno')?.textContent.trim() || '';
    L.push(`#### Question ${no}${t('.state') ? ` (${t('.state')}${t('.grade') ? `, ${t('.grade')}` : ''})` : ''}`, '', t('.qtext'));
    const opts = [...q.querySelectorAll('.answer > div')].map((o) => {
      const picked = o.querySelector('input[checked], input:checked');
      return `- ${picked ? '[my answer] ' : ''}${htmlToText(o.innerHTML).replace(/\n+/g, ' ')}`;
    });
    if (opts.length) L.push('', ...opts);
    else if (q.querySelector('.answer input[type="text"], .answer textarea')) {
      const v = q.querySelector('.answer input[type="text"]')?.getAttribute('value') || q.querySelector('.answer textarea')?.textContent || '';
      if (v) L.push('', `My answer: ${v}`);
    }
    for (const sel of ['.specificfeedback', '.generalfeedback', '.rightanswer']) if (t(sel)) L.push('', t(sel));
    L.push('');
  }
  return L.join('\n').trim();
}

// Reads every reviewable attempt of a quiz. Used by the Claude export.
export async function readQuiz(url, limit = 5) {
  const view = await getHtml(url);
  const attempts = quizAttempts(view).slice(-limit);
  const out = [];
  for (const a of attempts) {
    try {
      const doc = await getHtml(a.url);
      const text = quizText(doc);
      if (text) out.push({ ...a, text, grade: doc.querySelector('.quizreviewsummary')?.textContent.match(/Grade\s*([\d.,]+\s*out of\s*[\d.,]+)/i)?.[1] || '' });
    } catch (e) {
      if (e instanceof NotLoggedIn) throw e;
    }
  }
  return out;
}

// ------------------------------------------------------------ one course

// What to open for each kind of activity. Anything not listed gets its main page.
function pagesFor(m) {
  const id = m.id;
  if (m.modname === 'book') return `${SCELE_URL}/mod/book/tool/print/index.php?id=${id}`;
  return m.url || `${SCELE_URL}/mod/${m.modname}/view.php?id=${id}`;
}

// Saves a whole course. The caller passes in how to write files:
//   saveText(path, text, type)   a file we made (path is relative to the course folder)
//   saveUrl(path, url, key)      a file to download from SCeLE (key: skip it if already downloaded)
//   files                        the course's normal files (from courseFiles), each with .path relative to the
//                                course folder. The caller downloads the named ones; unnamed ones are looked up here.
//   savedAttempts                Set of quiz attempt ids saved in an earlier run, skipped this time
// Returns { saved, skipped: [{ name, why }], attempts: [ids], index }.
export async function archiveCourse(course, sections, { saveText, saveUrl, files = [], savedAttempts = new Set(), onProgress = () => {} }) {
  const courseName = course.fullname || course.shortname;
  const entries = []; // for index.html: { section, name, modname, links: [{ label, path }], note }
  const skipped = [];
  const newAttempts = [];
  let saved = 0;

  const jobs = [];
  sections.forEach((sec) => {
    for (const m of sec.modules) {
      if (m.modname === 'label') continue;
      const entry = { section: sec.name, name: m.name, modname: m.modname, links: [], note: '', url: m.url };
      entries.push(entry);
      if (m.modname === 'resource' || m.modname === 'folder') {
        const mine = files.filter((x) => x.mod === m.id);
        for (const f of mine) if (f.name) entry.links.push({ label: f.name, path: f.path });
        const unnamed = mine.find((f) => !f.name);
        if (unnamed) jobs.push({ m, sec, entry, file: unnamed });
        continue;
      }
      jobs.push({ m, sec, entry });
    }
  });

  let done = 0;
  const step = () => onProgress({ label: `Saving ${course.shortname}`, done: ++done, total: jobs.length });

  const saveSnap = async (doc, { title, path, source, pick }) => {
    const dir = path.replace(/\.html$/, '');
    const base = path.split('/').slice(0, -1).join('/');
    const rel = dir.split('/').pop();
    const snap = await snapshot(doc, { title, course: courseName, source, dir: rel, pick });
    await saveText(path, snap.html, 'text/html');
    saved++;
    for (const a of snap.attachments) {
      await saveUrl(base ? `${base}/${a.path}` : a.path, a.url, a.url);
      saved++;
    }
    return snap;
  };

  await pool(jobs, 3, async ({ m, sec, entry, file }) => {
    const folder = safeName(sec.name);
    const name = safeName(m.name) || `${m.modname} ${m.id}`;
    try {
      if (m.modname === 'quiz') {
        const view = await getHtml(m.url || `${SCELE_URL}/mod/quiz/view.php?id=${m.id}`);
        const p = `${folder}/${name}/Summary.html`;
        await saveSnap(view, { title: m.name, path: p, source: m.url });
        entry.links.push({ label: 'Summary and grades', path: p });
        const attempts = quizAttempts(view);
        for (const a of attempts) {
          const ap = `${folder}/${name}/${a.label}.html`;
          entry.links.push({ label: `${a.label} (questions and answers)`, path: ap });
          if (savedAttempts.has(a.id)) continue;
          const doc = await getHtml(a.url);
          await saveSnap(doc, { title: `${m.name}, ${a.label}`, path: ap, source: a.url });
          newAttempts.push(a.id);
        }
        const finishedRows = view.querySelectorAll('.quizattemptsummary tr').length - 1;
        if (!attempts.length) entry.note = finishedRows > 0 ? 'The lecturer has not opened the review, so only your grade is saved.' : 'No finished attempts yet.';
        else if (finishedRows > attempts.length) entry.note = 'Some attempts are not open for review yet.';
      } else if (m.modname === 'forum') {
        const view = await getHtml(m.url);
        const p = `${folder}/${name}.html`;
        await saveSnap(view, { title: m.name, path: p, source: m.url });
        entry.links.push({ label: 'Topics', path: p });
        const topics = [...new Map([...view.querySelectorAll('a[href*="/mod/forum/discuss.php?d="]')]
          .map((a) => [new URL(a.getAttribute('href'), SCELE_URL).searchParams.get('d'), a.textContent.trim()])).entries()].slice(0, 60);
        for (const [d, t] of topics) {
          const tp = `${folder}/${name}/${safeName(t) || `Topic ${d}`}.html`;
          const doc = await getHtml(`${SCELE_URL}/mod/forum/discuss.php?d=${d}`);
          await saveSnap(doc, { title: t, path: tp, source: `${SCELE_URL}/mod/forum/discuss.php?d=${d}` });
          entry.links.push({ label: t, path: tp });
        }
      } else if (m.modname === 'resource') {
        // A file the API didn't describe: ask SCeLE for its name, then download it.
        const r = await fetch(file.url, { credentials: 'include' });
        r.body?.cancel();
        if (/\/login\/index\.php/.test(r.url)) throw new NotLoggedIn();
        if (isPluginfile(r.url)) {
          const p = `${folder}/${safeName(pluginfileName(r.url))}`;
          await saveUrl(p, r.url, file.key);
          saved++;
          entry.links.push({ label: pluginfileName(r.url), path: p });
        }
      } else {
        const src = pagesFor(m);
        const doc = await getHtml(src);
        const p = `${folder}/${name}.html`;
        const snap = await saveSnap(doc, { title: m.name, path: p, source: m.url });
        entry.links.push({ label: m.modname === 'book' ? 'Whole book' : 'Saved page', path: p });
        if (m.modname === 'url') {
          const out = doc.querySelector('.urlworkaround a, .resourcecontent a, [role="main"] a[href^="http"]:not([href*="scele.cs.ui.ac.id"])');
          if (out) entry.external = out.getAttribute('href');
        }
        if (/^(scorm|h5pactivity|lti|hvp)$/.test(m.modname)) entry.note = 'Interactive content runs on SCeLE, so only its page is saved.';
        if (!snap.text.trim()) entry.note = entry.note || 'This page was empty.';
      }
    } catch (e) {
      if (e instanceof NotLoggedIn) throw e;
      entry.note = "Couldn't be saved this time.";
      skipped.push({ name: m.name, why: e.message });
    } finally {
      step();
    }
  });

  const index = courseIndex(course, entries);
  await saveText('index.html', index, 'text/html');
  saved++;
  return { saved, skipped, attempts: newAttempts, entries };
}

// ------------------------------------------------------------ index.html

export function courseIndex(course, entries, at = now()) {
  const bySection = new Map();
  for (const e of entries) {
    if (!bySection.has(e.section)) bySection.set(e.section, []);
    bySection.get(e.section).push(e);
  }
  const rel = (p) => p.split('/').map(encodeURIComponent).join('/');
  const sections = [...bySection].map(([name, list]) => `<section><h2>${esc(name)}</h2><ul>${list.map((e) => `
    <li data-q="${esc(`${e.name} ${moduleLabel(e.modname)} ${e.links.map((l) => l.label).join(' ')}`.toLowerCase())}">
      <span class="k">${esc(moduleLabel(e.modname) || 'Item')}</span><b>${esc(e.name)}</b>
      ${e.links.map((l) => `<a href="${rel(l.path)}">${esc(l.label)}</a>`).join('')}
      ${e.external ? `<a href="${esc(e.external)}">Open link</a>` : ''}
      ${!e.links.length && !e.external && e.url ? `<a href="${esc(e.url)}">On SCeLE</a>` : ''}
      ${e.note ? `<span class="note">${esc(e.note)}</span>` : ''}
    </li>`).join('')}</ul></section>`).join('');
  const when = new Date(at * 1000).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(course.shortname)}: offline copy</title><style>${PAGE_CSS}
h1{margin:0 0 4px} .sub{color:var(--ink2);margin:0 0 20px} input{font:inherit;width:100%;box-sizing:border-box;padding:10px 14px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink)}
section h2{font-size:17px;margin:28px 0 8px} ul{list-style:none;margin:0;padding:0;border:1px solid var(--line);border-radius:10px}
li{padding:10px 14px;border-top:1px solid var(--line);display:flex;flex-wrap:wrap;gap:6px 12px;align-items:baseline} li:first-child{border-top:0}
li b{flex:1 1 220px} .k{font-size:12px;color:var(--ink2);min-width:70px} li a{font-size:14px} .note{flex-basis:100%;font-size:13px;color:var(--ink2)}
</style></head><body><div class="sc-main">
<h1>${esc(course.fullname)}</h1><p class="sub">${esc(course.shortname)}. Offline copy saved ${esc(when)} with Sceleton. Save again any time and only new things are added.</p>
<input type="search" placeholder="Filter" aria-label="Filter" autofocus>
${sections || '<p>This course page is empty.</p>'}
</div><script>
const box=document.querySelector('input');box.oninput=()=>{const q=box.value.toLowerCase().trim();
document.querySelectorAll('li').forEach(li=>li.hidden=q&&!li.dataset.q.includes(q));
document.querySelectorAll('section').forEach(s=>s.hidden=![...s.querySelectorAll('li')].some(li=>!li.hidden));};
</script></body></html>`;
}
