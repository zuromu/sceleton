// End-to-end test: loads the dev build into a real Chromium, logs in to the
// fake SCeLE and checks that every part of Sceleton works. Also saves
// screenshots to docs/screenshots.
//
//   python3 dev/mock_scele.py &      (or with --limited)
//   node dev/build-dev.mjs
//   node dev/e2e.mjs [--limited] [--no-shots]

import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ext = join(here, 'build', 'extension');
const shots = join(here, '..', 'docs', 'screenshots');
const MOCK = 'http://127.0.0.1:8765';
const DOWNLOADS = mkdtempSync(join(tmpdir(), 'sceleton-dl-'));
const LIMITED = process.argv.includes('--limited');
const SHOTS = !process.argv.includes('--no-shots');
mkdirSync(shots, { recursive: true });

let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}`);
  if (!cond) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'sceleton-')), {
  channel: 'chromium',
  headless: true,
  timezoneId: 'Asia/Jakarta',
  locale: 'en-GB',
  viewport: { width: 1360, height: 900 },
  deviceScaleFactor: 2,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});

let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const id = sw.url().split('/')[2];
const APP = `chrome-extension://${id}/app/index.html`;
console.log(`Extension ${id}, mock ${LIMITED ? 'limited' : 'full'} API`);

const storage = (keys) => sw.evaluate((k) => chrome.storage.local.get(k), keys);
const refresh = () => sw.evaluate(() => new Promise((res) => {
  // Same path the alarm takes, via the message handler.
  chrome.runtime.sendMessage({ type: 'refresh' }, res);
  setTimeout(res, 15000);
}));
const sendFromPage = async (page, msg) => page.evaluate((m) => chrome.runtime.sendMessage(m), msg);
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await wait(100); }
  return false;
};

// ------------------------------------------------------------ 1. logged out
await wait(1500);
const welcome = ctx.pages().find((p) => p.url().startsWith(APP)) || await ctx.newPage();
if (!welcome.url().startsWith(APP)) await welcome.goto(APP);
await welcome.waitForSelector('.hello h1, .headline', { timeout: 15000 });
ok(await welcome.locator('.hello h1').count() === 1, 'shows the log in screen before logging in');
const auth0 = (await storage('auth')).auth;
ok(auth0?.status === 'loggedout', `background knows we are logged out (${auth0?.status})`);
ok(await sw.evaluate(() => chrome.action.getBadgeText({})) === '!', 'badge shows "!" when logged out');
if (SHOTS && !LIMITED) await welcome.screenshot({ path: join(shots, 'welcome.png') });

// ------------------------------------------------------------ 2. log in on the SCeLE site
const scelePage = await ctx.newPage();
await scelePage.goto(`${MOCK}/login/index.php`);
await scelePage.fill('#username', 'ahmad.hoesin');
await scelePage.fill('#password', 'pw');
await Promise.all([scelePage.waitForURL('**/my/'), scelePage.click('#loginbtn')]);
// the content script tells the background we logged in, which syncs
for (let i = 0; i < 40; i++) {
  const a = (await storage('auth')).auth;
  if (a?.status === 'ok') break;
  await wait(250);
}
const { auth, events, courses } = await storage(['auth', 'events', 'courses']);
ok(auth?.status === 'ok' && auth.name === 'Ahmad Hoesin', `synced after logging in on SCeLE (name: ${auth?.name})`);
ok(events?.list?.length === 13, `got all deadlines (${events?.list?.length})`);
ok(courses?.list?.length === 8, `got all courses (${courses?.list?.length})`);
ok(events.list.every((e) => e.cmid > 0), 'every deadline knows its activity id');

// the welcome tab should have switched to the dashboard by itself
await welcome.waitForSelector('.headline', { timeout: 10000 });
ok(true, 'dashboard updated itself after login');

// ------------------------------------------------------------ 3. background sync of course pages
for (let i = 0; i < 40; i++) {
  const c = (await storage('contents')).contents || {};
  if (Object.keys(c).length === 8) break;
  await wait(250);
}
const { contents, known } = await storage(['contents', 'known']);
ok(Object.keys(contents || {}).length === 8, `background read all 8 course pages (${Object.keys(contents || {}).length})`);
const via = [...new Set(Object.values(contents || {}).map((c) => c.via))];
ok(via.length === 1 && via[0] === (LIMITED ? 'page' : 'api'), `course pages came from the ${LIMITED ? 'HTML page' : 'API'} (${via})`);
ok(Object.keys(known || {}).length === 8, 'remembers what is on each course page');
const pbp = contents?.[101]?.sections || [];
ok(pbp.length === 9, `PBP has 9 sections (${pbp.length})`);
const slides = pbp[1]?.modules?.find((m) => m.modname === 'resource');
ok(slides && slides.files.length === 1, 'slides have a downloadable file');
if (!LIMITED) ok(slides.files[0].url.includes('/pluginfile.php/') && !slides.files[0].url.includes('/webservice/'), 'file links use the browser-friendly path');
const badge = await sw.evaluate(() => chrome.action.getBadgeText({}));
ok(badge === '3', `badge counts overdue + due within 24h (${badge})`);

// ------------------------------------------------------------ 3b. pick the courses you're actually taking
await welcome.goto(`${APP}#/home`);
await welcome.waitForSelector('.banner.tip');
ok(true, 'home suggests choosing courses');
await welcome.click('.banner.tip [data-act="pick-courses"]');
await welcome.waitForSelector('.pick-list');
ok(await welcome.locator('.pick-list input:checked').count() === 8, 'picker starts with every course ticked');
if (SHOTS && !LIMITED) await welcome.screenshot({ path: join(shots, 'picker.png') });
await welcome.click('.pick-list label:has-text("Advanced Programming") .toggle');
await welcome.click('.pick-list label:has-text("Machine Learning") .toggle');
await welcome.click('[data-pick-done]');
await wait(800);
const st = (await storage('settings')).settings;
ok(JSON.stringify(st.hiddenCourses.sort()) === '[107,108]', `hidden courses saved (${st.hiddenCourses})`);
ok(await welcome.locator('.banner.tip').count() === 0, 'tip goes away after choosing');
ok(await welcome.locator('text=ML assignment 2').count() === 0, 'deadlines from courses you are not taking disappear');
const badge2 = await sw.evaluate(() => chrome.action.getBadgeText({}));
ok(badge2 === '2', `badge ignores courses you are not taking (${badge2})`);
const rem2 = (await sw.evaluate(() => chrome.alarms.getAll())).filter((a) => a.name.startsWith('remind|'));
const mlEvent = (await storage('events')).events.list.find((e) => e.courseId === 108);
ok(!rem2.some((a) => a.name.startsWith(`remind|${mlEvent.id}|`)), 'no reminders for courses you are not taking');
const alarms = await sw.evaluate(() => chrome.alarms.getAll());
const reminders = alarms.filter((a) => a.name.startsWith('remind|'));
ok(reminders.length >= 10, `reminders scheduled (${reminders.length})`);
ok(alarms.some((a) => a.name === 'refresh' && a.periodInMinutes === 30), 'syncs every 30 minutes');

// ------------------------------------------------------------ 4. new material + new announcement
await fetch(`${MOCK}/__dev/add-material?course=101`, { method: 'POST' });
await fetch(`${MOCK}/__dev/add-notification`, { method: 'POST' });
await sw.evaluate(() => chrome.storage.local.get('contents').then(({ contents }) => {
  Object.values(contents).forEach((c) => { c.at = 0; });
  return chrome.storage.local.set({ contents });
}));
await sendFromPage(welcome, { type: 'refresh' });
const { fresh, inbox } = await storage(['fresh', 'inbox']);
ok(fresh?.[101]?.length === 1 && /Midterm review/.test(fresh[101][0].name), `spotted the new slides (${fresh?.[101]?.map((m) => m.name)})`);
ok(inbox?.unread === 3, `new announcement counted (${inbox?.unread} unread)`);
const notes = await sw.evaluate(() => chrome.notifications.getAll());
const noteIds = Object.keys(notes);
ok(noteIds.some((n) => n.startsWith('fresh|101')), 'notification for new material');
ok(noteIds.some((n) => n.startsWith('inbox|')), 'notification for new announcement');

// ------------------------------------------------------------ 5. dashboard pages
const app = welcome;
await app.goto(`${APP}#/home`);
await app.waitForSelector('.spine .vert');
const headline = await app.textContent('.headline');
ok(/due|overdue|Nothing|clear/.test(headline), `headline: "${headline}"`);
ok(await app.locator('.spine .vert').count() === 15, 'spine has 14 days plus an overdue vertebra');
ok(await app.locator('text=Attendance week 9').count() === 0, 'attendance is hidden by default');
ok(await app.locator('.stack .rows .row').count() >= 2, 'home shows new material and inbox');
if (SHOTS && !LIMITED) await app.screenshot({ path: join(shots, 'home.png'), fullPage: true });

// tick something off
const before = await sw.evaluate(() => chrome.action.getBadgeText({}));
await app.click('.row:has-text("Lab 6: Normalization") .tick');
await wait(400);
ok((await storage('done')).done && Object.keys((await storage('done')).done).length === 1, 'ticking off saves it');
const after = await sw.evaluate(() => chrome.action.getBadgeText({}));
ok(Number(after) === Number(before) - 1, `badge goes down after ticking off (${before} to ${after})`);
await app.click('.row:has-text("Lab 6: Normalization") .tick').catch(() => {});

// deadlines page
await app.goto(`${APP}#/deadlines`);
await app.waitForSelector('.filters');
const rowsAll = await app.locator('.panel .row').count();
await app.click('.chip:has-text("PBP KI")');
await until(async () => await app.locator('.panel .row').count() === 2);
const rowsPbp = await app.locator('.panel .row').count();
ok(rowsAll >= 9 && rowsPbp === 2, `course filter works (${rowsAll} then ${rowsPbp})`);
await app.click('.chip:has-text("All courses")');
const [ics] = await Promise.all([app.waitForEvent('download'), app.click('[data-act="ics"]')]);
ok(ics.suggestedFilename() === 'scele-deadlines.ics', 'calendar export downloads an .ics file');
if (SHOTS && !LIMITED) await app.screenshot({ path: join(shots, 'deadlines.png'), fullPage: true });

// courses
await app.goto(`${APP}#/courses`);
await app.waitForSelector('.course-card');
ok(await app.locator('.course-card').count() === 6, 'six course cards for the courses you take');
ok(await app.locator('.row:has-text("Machine Learning") [data-act="track"]').count() === 1, 'other courses listed under "Not taking"');
ok(await app.locator('.course-card:has-text("PBP KI") .pill.fresh').count() === 1, 'PBP card shows "1 new"');
if (SHOTS && !LIMITED) await app.screenshot({ path: join(shots, 'courses.png'), fullPage: true });

await app.click('.course-card:has-text("PBP KI")');
await app.waitForSelector('.section');
await app.waitForSelector('.course-head');
const freshRows = await app.locator('.row.is-fresh').count();
ok(freshRows === 1, 'the new slides are highlighted on the course page');
if (!LIMITED) ok(await app.locator('.files li').count() >= 3, 'folder files are listed');
if (SHOTS && !LIMITED) await app.screenshot({ path: join(shots, 'course.png'), fullPage: false });
await wait(300);
ok(!(await storage('fresh')).fresh?.[101], 'opening the course clears its "new" marker');

// downloads: record the exact paths Sceleton asks Chromium to save to
await sw.evaluate(() => {
  self.__asked = [];
  const real = chrome.downloads.download.bind(chrome.downloads);
  chrome.downloads.download = (opts) => { self.__asked.push(opts); return real(opts); };
});
await app.click('[data-act="dl-course"]');
await until(async () => (await sw.evaluate(() => self.__asked.length)) >= (LIMITED ? 10 : 22), 10000);
const asked = await sw.evaluate(() => self.__asked);
const names = asked.map((o) => o.filename || '(name chosen by SCeLE)');
console.log('       e.g.', names.slice(0, 2).join(' | '));
ok(asked.length >= (LIMITED ? 10 : 22), `downloaded every file in the course (${asked.length})`);
if (!LIMITED) {
  ok(names.some((n) => /^SCeLE\/PBP KI\/Week 2 - Models, views and templates\/Lab 1 starter code\/src\/(views|tests)\.py$/.test(n)), 'files land in Downloads/SCeLE/<course>/<section>/<folder>/...');
  ok(names.includes('SCeLE/PBP KI/Week 1 - Web and Django basics/W01 Web and Django basics.pdf'), 'slides keep their real file name');
} else {
  ok(asked.every((o) => !o.filename && /redirect=1/.test(o.url)), 'in HTML mode, files are fetched through the SCeLE file link');
}
const { downloaded } = await storage('downloaded');
ok(Object.keys(downloaded || {}).length === asked.length, `remembers what was downloaded (${Object.keys(downloaded || {}).length})`);
await app.waitForSelector('text=Download all again');
ok(true, 'button changes to "Download all again"');

// inbox
await app.goto(`${APP}#/inbox`);
await app.waitForSelector('.note-row');
ok(await app.locator('.note-row.unread').count() === 3, 'three unread in the inbox');
const [popupTab] = await Promise.all([ctx.waitForEvent('page'), app.click('.note-row.unread >> nth=0')]);
await popupTab.close();
await until(async () => (await storage('inbox')).inbox?.unread === 2);
ok(await app.locator('.note-row.unread').count() === 2 && (await storage('inbox')).inbox?.unread === 2, 'opening a notification marks it read, on SCeLE too');
if (SHOTS && !LIMITED) await app.screenshot({ path: join(shots, 'inbox.png'), fullPage: true });

// grades
await app.goto(`${APP}#/grades`);
await app.waitForSelector('.grade-row');
ok(await app.locator('.grade-row').count() === 10, `grades for 6 taken and 4 other courses (${await app.locator('.grade-row').count()})`);
await app.click('.grade-row:has-text("Platform-Based Programming")');
await app.waitForSelector('.grade-detail table');
ok(await app.locator('.grade-detail tr').count() >= 8, 'grade breakdown opens');
if (SHOTS && !LIMITED) await app.screenshot({ path: join(shots, 'grades.png'), fullPage: true });

// ------------------------------------------------------------ 5b. export for Claude
await fetch(`${MOCK}/__dev/add-page?course=101`, { method: 'POST' });
await app.goto(`${APP}#/courses/101`);
await app.waitForSelector('.course-head');
// capture the clipboard and every file Sceleton saves, without touching the real ones
await app.evaluate(() => {
  window.__clip = null;
  navigator.clipboard.writeText = async (t) => { window.__clip = t; };
  window.__saved = [];
  const real = chrome.downloads.download.bind(chrome.downloads);
  chrome.downloads.download = (o) => {
    fetch(o.url).then((r) => r.arrayBuffer()).then((b) => window.__saved.push({ name: o.filename, bytes: Array.from(new Uint8Array(b)) }));
    return real(o);
  };
});
await app.click('[data-act="export"]');
await app.waitForSelector('.exporter .exp-opt');
ok(await app.locator('.exp-opt').count() === 3, 'export offers copy, .md and .zip for a course');
if (SHOTS && !LIMITED) await app.screenshot({ path: join(shots, 'export.png') });

await app.click('[data-exp="copy"]');
await app.waitForSelector('.exporter .exp-done', { timeout: 60000 });
const md = await app.evaluate(() => window.__clip);
ok(md?.startsWith('# Platform-Based Programming'), 'copied text starts with the course name');
ok(/Course code: PBP KI/.test(md), 'copied text has the course code');
ok(/My grade so far: 88\.40/.test(md), 'copied text has the grade so far');
ok(/\*\*Tugas Individu 7\*\* \(Assignment\), due .*\(in \d+h/.test(md), 'copied text lists upcoming deadlines with a countdown');
ok(/Implement the features listed in the handout for Tugas Individu 7\./.test(md) && /- Push your code to GitHub/.test(md), 'copied text has the assignment description, with its bullets');
ok(/Quizzes count for 30%/.test(md), 'copied text has the text of course pages');
ok(/Slides week 1: Web and Django basics/.test(md), 'copied text lists the course material');
if (!LIMITED) {
  ok(/### Deadline Tugas Individu 7 diperpanjang/.test(md) && /- Deploy ke PWS/.test(md), 'copied text has announcements, with their bullets');
  ok(/RPS \(https:\/\/example\.com\/rps\)/.test(md), 'links in announcements keep their address');
} else {
  ok(/couldn't be read on this SCeLE/.test(md) && /Recent SCeLE notifications/.test(md), 'without the forum API it says so and falls back to notifications');
}
ok(!/undefined|\[object|NaN|—/.test(md), 'no stray "undefined" or em dashes in the text');
ok(!/Machine Learning|Advanced Programming/.test(md), 'only that course is in there');
await app.click('.exporter [data-exp-close]');

// .md download
await app.click('[data-act="export"]');
await app.click('[data-exp="md"]');
await app.waitForSelector('.exporter .exp-done', { timeout: 60000 });
await until(async () => (await app.evaluate(() => window.__saved.length)) >= 1);
let saved = await app.evaluate(() => window.__saved);
ok(saved[0]?.name === 'SCeLE/PBP KI/PBP KI context.md', `context.md goes to Downloads/SCeLE/<course> (${saved[0]?.name})`);
ok(Buffer.from(saved[0].bytes).toString('utf8').startsWith('# Platform-Based Programming'), 'the saved file is the same text');
await app.click('.exporter [data-exp-close]');

// .zip download
await app.click('[data-act="export"]');
await app.uncheck('[data-exp-details]');
await app.click('[data-exp="zip"]');
await app.waitForSelector('.exporter .exp-done', { timeout: 90000 });
ok((await storage('settings')).settings?.exportDetails === false, 'remembers the "read descriptions" choice');
await until(async () => (await app.evaluate(() => window.__saved.length)) >= 2);
saved = await app.evaluate(() => window.__saved);
const zipFile = saved[1];
ok(zipFile?.name === 'SCeLE/PBP KI/PBP KI for Claude.zip', `zip goes to Downloads/SCeLE/<course> (${zipFile?.name})`);
const zipPath = join(DOWNLOADS, 'export.zip');
writeFileSync(zipPath, Buffer.from(zipFile.bytes));
const py = `
import json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
names = z.namelist()
out = {"bad": z.testzip(), "names": names}
slide = "PBP KI/files/Week 1 - Web and Django basics/W01 Web and Django basics.pdf"
out["slide"] = z.read(slide).decode() if slide in names else None
out["claude"] = z.read("PBP KI/CLAUDE.md").decode()
out["context"] = z.read("PBP KI/context.md").decode()
print(json.dumps(out))`;
const zinfo = JSON.parse(execFileSync('python3', ['-c', py, zipPath]).toString());
ok(zinfo.bad === null, 'the zip passes Python\'s own integrity check (CRC and structure)');
ok(zinfo.names.length >= 11, `zip holds context, CLAUDE.md and the course files (${zinfo.names.length} entries)`);
ok(zinfo.slide !== null && /^fake contents of W01/.test(zinfo.slide), `a file inside the zip has the right name and contents (${JSON.stringify(zinfo.slide)})`);
if (!LIMITED) ok(zinfo.names.includes('PBP KI/files/Week 2 - Models, views and templates/Lab 1 starter code/src/views.py'), 'folder files keep their subfolders');
ok(/@context\.md/.test(zinfo.claude) && /files\//.test(zinfo.claude), 'CLAUDE.md points Claude Code at context.md');
ok(zinfo.context.includes('saved as `files/Week 1 - Web and Django basics/W01 Web and Django basics.pdf`'), 'context.md says where each file is inside the zip');
ok(!/Implement the features listed/.test(zinfo.context), 'unticking the descriptions option leaves them out');
await app.click('.exporter [data-exp-close]');
await store_reset_details();

// whole semester
await app.goto(`${APP}#/courses`);
await app.waitForSelector('[data-act="export-semester"]');
await app.click('[data-act="export-semester"]');
ok(await app.locator('.exp-opt').count() === 2, 'semester export offers copy and .md only');
await app.click('[data-exp="copy"]');
await app.waitForSelector('.exporter .exp-done', { timeout: 30000 });
const sem = await app.evaluate(() => window.__clip);
ok(sem.startsWith('# My semester so far') && /### Platform-Based Programming \(PBP KI\)/.test(sem), 'semester text has each course');
ok(/Grade so far: 88\.40/.test(sem) && /Due in the next 30 days/.test(sem), 'semester text has grades and what is due');
ok(!/Machine Learning|ML assignment 2/.test(sem), 'semester text leaves out courses you are not taking');
await app.click('.exporter [data-exp-close]');

// from the search palette
await app.goto(`${APP}#/courses/101`);
await app.waitForSelector('.course-head');
await app.keyboard.press('Control+K');
await app.fill('.palette input', 'export');
await wait(150);
ok(/Export PBP KI for Claude/.test(await app.textContent('.palette li[aria-selected="true"] .t')), 'search offers "Export <course> for Claude" on a course page');
await app.keyboard.press('Escape');

async function store_reset_details() {
  await sw.evaluate(() => chrome.storage.local.get('settings').then(({ settings }) => chrome.storage.local.set({ settings: { ...settings, exportDetails: true } })));
}

// search
await app.goto(`${APP}#/home`);
await app.waitForSelector('.headline');
await app.keyboard.press('Control+K');
await app.waitForSelector('.palette input');
await app.keyboard.type('normalizaton');
await wait(150);
const firstHit = await app.textContent('.palette li[aria-selected="true"] .t');
ok(/Normalization/i.test(firstHit), `search forgives typos ("normalizaton" finds "${firstHit}")`);
await app.fill('.palette input', 'flutter state');
await wait(150);
ok(/Flutter state/i.test(await app.textContent('.palette li[aria-selected="true"] .t')), 'search finds course material');
if (SHOTS && !LIMITED) await app.screenshot({ path: join(shots, 'search.png') });
await app.keyboard.press('Escape');

// settings
await app.goto(`${APP}#/settings`);
await app.waitForSelector('.setting');
await app.click('[data-act="reminder"][data-h="1"]');
await wait(200);
ok((await storage('settings')).settings?.reminders?.includes(1), 'reminder choice saved');
if (SHOTS && !LIMITED) await app.screenshot({ path: join(shots, 'settings.png'), fullPage: true });
await app.selectOption('select[data-setting="theme"]', 'dark');
await wait(200);
await app.goto(`${APP}#/home`);
await app.waitForSelector('.spine');
ok(await app.evaluate(() => document.documentElement.dataset.theme) === 'dark', 'dark theme applies');
if (SHOTS && !LIMITED) await app.screenshot({ path: join(shots, 'home-dark.png'), fullPage: true });
await app.click('.side-foot [data-act="theme"]');
await until(async () => await app.evaluate(() => document.documentElement.dataset.theme) === 'light');
ok(await app.evaluate(() => document.documentElement.dataset.theme) === 'light', 'the moon/sun button in the sidebar switches theme');
await app.goto(`${APP}#/settings`);
await app.selectOption('select[data-setting="theme"]', 'auto');

// ------------------------------------------------------------ 6. popup
const popup = await ctx.newPage();
await popup.setViewportSize({ width: 380, height: 640 });
await popup.goto(`chrome-extension://${id}/popup/popup.html`);
await popup.waitForSelector('.lead h1');
ok(await popup.locator('.list .row').count() === 5, 'popup lists the next five deadlines');
if (SHOTS && !LIMITED) {
  const h = await popup.evaluate(() => document.body.scrollHeight);
  await popup.setViewportSize({ width: 380, height: h });
  await popup.screenshot({ path: join(shots, 'popup.png') });
}
await popup.close();

// ------------------------------------------------------------ 7. on SCeLE itself
const pbpTask = (await storage('events')).events.list.find((e) => e.name === 'Tugas Individu 7');
await scelePage.goto(pbpTask.url);
await scelePage.waitForSelector('#sceleton-chip', { timeout: 5000 });
const chipText = await scelePage.textContent('#sceleton-chip b');
ok(/\d+h \d\dm \d\ds left/.test(chipText), `countdown on the assignment page ("${chipText}")`);
if (SHOTS && !LIMITED) await scelePage.screenshot({ path: join(shots, 'countdown.png') });
await app.click('.toggle:has(input[data-setting="darkScele"])');
await wait(400);
ok(await scelePage.evaluate(() => document.documentElement.classList.contains('sceleton-dark')), 'dark mode turns on for SCeLE without reloading');
if (SHOTS && !LIMITED) await scelePage.screenshot({ path: join(shots, 'scele-dark.png') });
await app.click('.toggle:has(input[data-setting="darkScele"])');

// ------------------------------------------------------------ 8. session ends
await fetch(`${MOCK}/__dev/logout`, { method: 'POST' });
await sendFromPage(app, { type: 'refresh' });
ok((await storage('auth')).auth?.status === 'loggedout', 'notices when the SCeLE session ends');
ok(await sw.evaluate(() => chrome.action.getBadgeText({})) === '!', 'badge goes back to "!"');
await app.goto(`${APP}#/home`);
await app.waitForSelector('.hello h1');
ok(true, 'dashboard asks you to log in again');

// any errors in the extension pages?
const errors = [];
for (const p of ctx.pages()) p.on('pageerror', (e) => errors.push(e.message));
ok(errors.length === 0, `no page errors ${errors.join('; ')}`);

await ctx.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
