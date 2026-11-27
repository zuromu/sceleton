// Tells you when a new version of Sceleton is out.
//
// Sceleton is loaded as an unpacked extension, and browsers never update
// those by themselves. So once a day it asks GitHub for the latest release
// (one request, nothing about you is sent) and the dashboard and popup show
// a banner with a download button when there is a newer one.
// Turn it off in Settings, "Check for new versions".

import { RELEASES_URL } from './config.js';
import * as store from './store.js';
import { now, DAY } from './util.js';

// "0.10.1" > "0.9.3"
export function isNewer(latest, current) {
  const a = String(latest).replace(/^v/, '').split('.').map(Number);
  const b = String(current).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

export async function checkForUpdate({ force = false } = {}) {
  const settings = await store.getSettings();
  if (!settings.checkUpdates && !force) return null;
  const saved = await store.get('update', {});
  if (!force && saved.at > now() - DAY) return saved;
  try {
    const r = await fetch(RELEASES_URL, { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' });
    if (!r.ok) throw new Error(`GitHub returned ${r.status}`);
    const rel = await r.json();
    const zip = (rel.assets || []).find((a) => /\.zip$/i.test(a.name));
    const info = {
      at: now(),
      latest: String(rel.tag_name || '').replace(/^v/, ''),
      page: rel.html_url || '',
      zip: zip ? zip.browser_download_url : '',
      notes: String(rel.body || '').slice(0, 1500),
    };
    await store.set('update', info);
    return info;
  } catch (e) {
    await store.set('update', { ...saved, at: now() - DAY + 3 * 3600 }); // try again in 3 hours
    return saved;
  }
}

// What the dashboard and popup should show: null, or { latest, zip, page }.
export function available(update, settings, current = chrome.runtime.getManifest().version) {
  if (!update?.latest || !settings.checkUpdates) return null;
  if (!isNewer(update.latest, current)) return null;
  if (settings.skipVersion === update.latest) return null;
  return update;
}
