// Keeps plain markdown copies of your SCeLE data in your Downloads folder, so a
// notes app (Obsidian, Logseq, anything that reads .md files) can show them.
//
// It is off by default. When it is on, Sceleton keeps these up to date in
// Downloads/<download folder>/vault/:
//   deadlines.md          what is due, rewritten whenever a deadline changes
//   semester.md           your courses, grades so far and the next 30 days
//   courses/<course>.md   everything Sceleton knows about one course. These are
//                         made by the dashboard (they need to read SCeLE pages),
//                         so they refresh when you open Sceleton, a few times a day.
//
// How the files get there: if you have set up the small helper in native/
// (see native/install.sh), Sceleton hands the files to it and they are written
// straight into the folder you chose, silently. Without the helper they are
// saved as ordinary downloads, which is fine unless your browser is set to ask
// where to save every download.
//
// Nothing leaves your computer.

import { now, safeName, moduleLabel } from './util.js';

const pad = (n) => String(n).padStart(2, '0');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// 2026-11-11 23:55 (Wed), in your computer's own time zone.
function stamp(ts) {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} (${DAYS[d.getDay()]})`;
}

// Square brackets and pipes would break the list, so they are swapped out.
const clean = (s) => String(s || '').replace(/[\[\]|]/g, ' ').replace(/\s+/g, ' ').trim();

export function vaultLines(events, from = now()) {
  return events
    .filter((e) => e.time > from)
    .sort((a, b) => a.time - b.time || a.id - b.id)
    .map((e) => {
      const link = e.url ? ` | [open](${e.url})` : '';
      return `- [ ] ${stamp(e.time)} | ${clean(e.course)} | ${clean(e.name)} | ${moduleLabel(e.modname)}${link}`;
    });
}

export function renderVault(events, from = now()) {
  const lines = vaultLines(events, from);
  return [
    '# SCeLE deadlines',
    '',
    `Updated ${stamp(from)} by Sceleton. This file is replaced whenever your deadlines change, so do not edit it.`,
    '',
    lines.length ? lines.join('\n') : 'Nothing due.',
    '',
  ].join('\n');
}

// A short fingerprint of a file's text, so we can tell "same as last time"
// without keeping the whole text around.
export function fingerprint(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return `${text.length}:${h}`;
}

// The browser asks the background page what to call each download. These are
// the names we want for ours (see onDeterminingFilename in background.js).
export const vaultNames = new Map();

// Writes one file under vault/, unless it is the same as last time. `same` is
// the part of the text that matters for "has this changed" (the whole text
// when left out); pass it when the text carries a timestamp.
const HELPER = 'com.sceleton.vault';

// Hands one file to the helper. False when the helper is not set up or refuses.
async function viaHelper(path, text) {
  try {
    const answer = await chrome.runtime.sendNativeMessage(HELPER, { path, text });
    return !!(answer && answer.ok);
  } catch {
    return false;
  }
}

async function viaDownload(path, text, settings) {
  const root = safeName(settings.downloadFolder || 'SCeLE');
  const filename = `${root}/vault/${path}`;
  const url = `data:text/markdown;charset=utf-8,${encodeURIComponent(text)}`;
  vaultNames.set(url, filename);
  let id;
  try {
    id = await chrome.downloads.download({ url, filename, conflictAction: 'overwrite', saveAs: false });
  } finally {
    setTimeout(() => vaultNames.delete(url), 30000);
  }
  // Keep the browser's download list free of these.
  const tidy = (d) => {
    if (d.id !== id || !d.state || d.state.current === 'in_progress') return;
    chrome.downloads.onChanged.removeListener(tidy);
    if (d.state.current === 'complete') chrome.downloads.erase({ id });
  };
  chrome.downloads.onChanged.addListener(tidy);
}

// Writes one file under vault/, unless it is the same as last time. `same` is
// the part of the text that matters for "has this changed" (the whole text
// when left out); pass it when the text carries a timestamp.
// Returns false (nothing to do), 'helper' or 'download'.
export async function writeVaultFile(path, text, settings, store, same = text) {
  const mark = fingerprint(same);
  const marks = await store.get('vaultMarks', {});
  if (marks[path] === mark) return false;
  const how = await viaHelper(path, text) ? 'helper' : 'download';
  if (how === 'download') await viaDownload(path, text, settings);
  await store.update('vaultMarks', (m) => ({ ...m, [path]: mark }));
  return how;
}

// deadlines.md. `events` is the list you would see on the dashboard (hidden
// courses and ticked items left out).
export function writeVault(events, settings, store) {
  const from = now();
  return writeVaultFile('deadlines.md', renderVault(events, from), settings, store, vaultLines(events, from).join('\n'));
}

// A file name for one course's page.
export const coursePath = (course) => `courses/${safeName(course.shortname || `course-${course.id}`)}.md`;

// Lines that only say when the export was made. They are ignored when
// deciding whether a course or semester file has really changed.
export const withoutDate = (text) => text.split('\n').filter((l) => !/Exported from SCeLE with Sceleton on /.test(l)).join('\n');
