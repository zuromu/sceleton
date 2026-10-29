// Bits of UI that both the popup and the dashboard use.

import { icon } from './icons.js';
import {
  esc, now, rel, relShort, fmtTime, dayLabel, heat, courseHue, moduleLabel,
  startOfDay, DAY,
} from './util.js';

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const word = (n) => WORDS[n] || String(n);
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const things = (n) => (n === 1 ? 'thing' : 'things');

export const hue = (id) => `--hue:${courseHue(id)}`;

// The big sentence at the top: what matters right now, in plain words.
export function summary(events, t = now()) {
  const endOfToday = startOfDay(t) + DAY;
  const overdue = events.filter((e) => e.time < t);
  const upcoming = events.filter((e) => e.time >= t);
  const today = upcoming.filter((e) => e.time < endOfToday);
  const week = upcoming.filter((e) => e.time < t + 7 * DAY);
  const next = upcoming[0];
  const late = overdue.length ? ` You also have ${word(overdue.length)} overdue.` : '';

  if (today.length) {
    return {
      title: `${cap(word(today.length))} ${today.length === 1 ? 'thing is' : 'things are'} due today.`,
      sub: `${next.name} is next, ${rel(next.time, t)}.${late}`,
    };
  }
  if (overdue.length) {
    return {
      title: `${cap(word(overdue.length))} overdue, nothing else due today.`,
      sub: next ? `Next up is ${next.name}, ${rel(next.time, t)}.` : 'Nothing else coming up.',
    };
  }
  if (week.length) {
    return {
      title: `Nothing due today. ${cap(word(week.length))} ${things(week.length)} this week.`,
      sub: `First up is ${next.name}, ${rel(next.time, t)}.`,
    };
  }
  if (next) {
    return { title: 'Nothing due this week.', sub: `Next up is ${next.name}, ${dayLabel(next.time, t)}.` };
  }
  return { title: 'All clear.', sub: 'Nothing due in the next two months. Enjoy it.' };
}

const HEAT_ORDER = ['overdue', 'hot', 'warm', 'cool'];
const hottest = (items, t) => HEAT_ORDER.find((h) => items.some((e) => heat(e.time, t) === h)) || 'cool';

// The spine: one vertebra per day. Bigger and hotter means more is due.
export function spine(events, days = 14, t = now()) {
  const start = new Date(startOfDay(t) * 1000);
  const cells = [];
  const overdue = events.filter((e) => e.time < t);
  if (overdue.length) cells.push({ key: 'late', top: 'Late', bold: String(overdue.length), items: overdue, h: 'overdue' });
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const ds = Math.floor(d.getTime() / 1000);
    const items = events.filter((e) => e.time >= t && e.time >= ds && e.time < ds + DAY);
    cells.push({
      key: ds,
      top: i === 0 ? 'Today' : d.toLocaleDateString('en-GB', { weekday: 'short' }),
      bold: String(d.getDate()),
      items,
      h: hottest(items, t),
      today: i === 0,
      weekend: d.getDay() === 0 || d.getDay() === 6,
    });
  }
  return `<div class="spine" style="--days:${cells.length}" role="list" aria-label="Deadlines over the next ${days} days">${cells.map((c) => {
    const n = c.items.length;
    const label = n
      ? `${c.top} ${c.bold}: ${c.items.map((e) => `${e.name} (${e.course})`).join(', ')}`
      : `${c.top} ${c.bold}: nothing due`;
    const cls = `vert ${n ? `heat-${c.h}` : 'empty'} ${c.today ? 'today' : ''} ${c.weekend ? 'weekend' : ''}`;
    const inner = `<span class="bone" style="--n:${Math.min(n, 4)}">${n > 1 ? `<span class="num">${n}</span>` : ''}</span><span class="day">${esc(c.top)}<b>${esc(c.bold)}</b></span>`;
    return n
      ? `<button class="${cls}" role="listitem" data-act="day" data-day="${c.key}" title="${esc(label)}" aria-label="${esc(label)}">${inner}</button>`
      : `<div class="${cls}" role="listitem" aria-label="${esc(label)}">${inner}</div>`;
  }).join('')}</div>`;
}

export function eventRow(e, done = {}, { compact = false } = {}) {
  const isDone = !!done[e.id];
  const h = heat(e.time);
  const when = `${dayLabel(e.time)}, ${fmtTime(e.time)}`;
  return `<li class="row heat-${h}${isDone ? ' done' : ''}">
    <button class="tick${isDone ? ' on' : ''}" data-act="done" data-id="${e.id}" title="${isDone ? 'Mark as not done' : 'Mark as done'}" aria-label="${isDone ? 'Mark as not done' : 'Mark as done'}: ${esc(e.name)}">${icon('check', 13)}</button>
    <div class="main">
      <a class="title" href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.name)}</a>
      <div class="sub"><span class="cdot" style="${hue(e.courseId)}"></span>${esc(e.course)}${compact ? '' : `<span class="sep"></span>${esc(moduleLabel(e.modname))}`}${compact ? `<span class="sep"></span>${esc(when)}` : ''}</div>
    </div>
    <div class="end">
      ${compact ? '' : `<span class="when">${esc(when)}</span>`}
      <span class="countdown heat-${isDone ? 'cool' : h}">${isDone ? 'Done' : relShort(e.time)}</span>
    </div>
  </li>`;
}

// Splits deadlines into "Overdue", "Today", "Tomorrow", "Fri 31 Oct", ...
export function groupByDay(events, t = now()) {
  const groups = [];
  for (const e of events) {
    const key = e.time < t ? 'overdue' : startOfDay(e.time);
    let g = groups.find((x) => x.key === key);
    if (!g) {
      g = {
        key,
        label: key === 'overdue' ? 'Overdue' : dayLabel(e.time, t),
        h: key === 'overdue' ? 'overdue' : (startOfDay(e.time) === startOfDay(t) ? 'hot' : ''),
        items: [],
      };
      groups.push(g);
    }
    g.items.push(e);
  }
  return groups;
}

export function groupedList(events, done, opts = {}) {
  return groupByDay(events).map((g) => `
    <div class="group-label${g.h ? ` heat-${g.h}` : ''}" id="d-${g.key}">${esc(g.label)}</div>
    <ul class="rows">${g.items.map((e) => eventRow(e, done, opts)).join('')}</ul>`).join('');
}
