// Small helpers shared by the popup, the dashboard and the background worker.

export const HOUR = 3600;
export const DAY = 86400;
export const now = () => Math.floor(Date.now() / 1000);

// Escape text before putting it inside HTML strings.
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Moodle sends some names with HTML entities in them ("Lab &amp; Quiz").
export function decode(s) {
  if (!s) return '';
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ');
}

export function stripHtml(s) {
  return decode(String(s ?? '')
    .replace(/<(br|\/p|\/li|\/div|\/h\d)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

// Like stripHtml, but keeps list bullets, table rows and link addresses, so
// an assignment description still reads properly as plain text.
export function htmlToText(html) {
  return stripHtml(String(html ?? '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<a\s[^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
      const text = label.replace(/<[^>]+>/g, '').trim();
      return !text || text === href ? href : `${text} (${href})`;
    }));
}

// "in 3h 12m", "2d 4h ago"
export function rel(ts, from = now()) {
  const diff = ts - from;
  const d = Math.abs(diff);
  let s;
  if (d < 60) return diff <= 5 ? 'just now' : 'in under a minute';
  else if (d < HOUR) s = `${Math.floor(d / 60)}m`;
  else if (d < DAY) s = `${Math.floor(d / HOUR)}h ${Math.floor((d % HOUR) / 60)}m`;
  else s = `${Math.floor(d / DAY)}d ${Math.floor((d % DAY) / HOUR)}h`;
  return diff < 0 ? `${s} ago` : `in ${s}`;
}

// Short version for tight spaces: "3h left", "2d late"
export function relShort(ts, from = now()) {
  const d = Math.abs(ts - from);
  const s = d < HOUR ? `${Math.max(1, Math.floor(d / 60))}m` : d < DAY ? `${Math.floor(d / HOUR)}h` : `${Math.floor(d / DAY)}d`;
  return ts < from ? `${s} late` : `${s} left`;
}

const dateFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const longDateFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

export const fmtDate = (ts) => dateFmt.format(ts * 1000);
export const fmtTime = (ts) => timeFmt.format(ts * 1000);
export const fmtLongDate = (ts) => longDateFmt.format(ts * 1000);

export function startOfDay(ts) {
  const d = new Date(ts * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

// Friendly day name relative to today: "Today", "Tomorrow", "Fri 31 Oct".
export function dayLabel(ts, from = now()) {
  const diff = Math.round((startOfDay(ts) - startOfDay(from)) / DAY);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return fmtDate(ts);
}

// How urgent a deadline is. Used for colours everywhere.
export function heat(ts, from = now()) {
  const left = ts - from;
  if (left < 0) return 'overdue';
  if (left < DAY) return 'hot';
  if (left < 3 * DAY) return 'warm';
  return 'cool';
}

// Every course gets its own stable colour, picked from its id.
export function courseHue(id) {
  const hues = [212, 262, 168, 330, 28, 190, 290, 140, 0, 238];
  return hues[Math.abs(Number(id) || 0) % hues.length];
}

export function moduleLabel(modname) {
  return {
    assign: 'Assignment', quiz: 'Quiz', forum: 'Forum', resource: 'File', folder: 'Folder',
    url: 'Link', page: 'Page', book: 'Book', attendance: 'Attendance', workshop: 'Workshop',
    lesson: 'Lesson', choice: 'Choice', feedback: 'Feedback', label: 'Label', h5pactivity: 'H5P',
    scorm: 'SCORM', lti: 'External tool', glossary: 'Glossary', wiki: 'Wiki', data: 'Database',
  }[modname] || (modname ? modname[0].toUpperCase() + modname.slice(1) : '');
}

export function fmtSize(bytes) {
  if (!bytes) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

// Turns any text into something safe to use as a file or folder name.
export function safeName(s) {
  return stripHtml(s)
    .replace(/\s*:\s*/g, ' - ')
    .replace(/[\\/*?"<>|\n\r\t]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.-]+|[\s.-]+$/g, '')
    .slice(0, 80) || 'untitled';
}

// Tiny fuzzy matcher for the search palette. Returns a score, or 0 if no match.
export function fuzzy(query, text) {
  const q = query.toLowerCase().replace(/\s+/g, '');
  const t = text.toLowerCase();
  if (!q) return 1;
  const idx = t.indexOf(query.toLowerCase().trim());
  if (idx >= 0) return 1000 - idx - t.length / 100;
  let score = 0;
  let ti = 0;
  let streak = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return 0;
    streak = found === ti ? streak + 1 : 0;
    score += 1 + streak * 2 + (found === 0 || /[\s\-_:]/.test(t[found - 1]) ? 3 : 0);
    ti = found + 1;
  }
  return score;
}

// Builds an .ics calendar file. Apple Calendar, Google Calendar and Outlook all read it.
export function buildIcs(events, reminderHours = [24, 3]) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = (ts) => {
    const d = new Date(ts * 1000);
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  };
  const icsEsc = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Sceleton//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:SCeLE deadlines'];
  for (const e of events) {
    const summary = `[${e.course}] ${e.name}`;
    lines.push('BEGIN:VEVENT', `UID:sceleton-${e.id}@sceleton`, `DTSTAMP:${stamp(now())}`,
      `DTSTART:${stamp(e.time)}`, `DTEND:${stamp(e.time)}`, `SUMMARY:${icsEsc(summary)}`,
      `DESCRIPTION:${icsEsc(e.url || '')}`, `URL:${e.url || ''}`);
    for (const h of reminderHours) {
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `TRIGGER:-PT${h}H`, `DESCRIPTION:${icsEsc(summary)}`, 'END:VALARM');
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

// Pulls the course module id out of a SCeLE link like /mod/assign/view.php?id=123
export function cmidFromUrl(url) {
  const m = String(url || '').match(/\/mod\/\w+\/view\.php\?(?:.*&)?id=(\d+)/);
  return m ? Number(m[1]) : null;
}
