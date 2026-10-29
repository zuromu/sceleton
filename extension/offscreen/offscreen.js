// A hidden page whose only job is reading HTML for the background worker,
// because service workers don't have DOMParser.
import { PARSERS } from '../lib/scele.js';

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.target !== 'offscreen') return;
  try {
    reply({ ok: true, data: PARSERS[msg.kind](msg.html) });
  } catch (e) {
    reply({ ok: false, error: String(e) });
  }
});
