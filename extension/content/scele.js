// Runs on scele.cs.ui.ac.id pages.
//  1. Tells Sceleton when you log in, so it can sync right away.
//  2. Optional dark mode for SCeLE.
//  3. A live countdown in the corner of assignment and quiz pages.

(() => {
  const root = document.documentElement;
  let settings = { darkScele: false, countdown: true };
  let events = [];
  let chip = null;
  let timer = null;

  const applyDark = () => root.classList.toggle('sceleton-dark', !!settings.darkScele);

  chrome.storage.local.get(['settings', 'events']).then((saved) => {
    settings = { ...settings, ...(saved.settings || {}) };
    events = saved.events?.list || [];
    applyDark();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
    else ready();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) {
      settings = { ...settings, ...(changes.settings.newValue || {}) };
      applyDark();
      showCountdown();
    }
    if (changes.events) {
      events = changes.events.newValue?.list || [];
      showCountdown();
    }
  });

  function ready() {
    const isLoginPage = /\/login\//.test(location.pathname);
    const hasSession = [...document.scripts].some((s) => /"sesskey"\s*:\s*"[^"]+"/.test(s.textContent));
    if (hasSession && !isLoginPage) {
      chrome.runtime.sendMessage({ type: 'page-logged-in' }).catch(() => {});
    }
    showCountdown();
  }

  // ------------------------------------------------------------ countdown

  function heat(left) {
    if (left < 0) return 'overdue';
    if (left < 86400) return 'hot';
    if (left < 3 * 86400) return 'warm';
    return 'cool';
  }

  function fmtLeft(left) {
    const d = Math.abs(left);
    const days = Math.floor(d / 86400);
    const h = Math.floor((d % 86400) / 3600);
    const m = Math.floor((d % 3600) / 60);
    const s = Math.floor(d % 60);
    const pad = (n) => String(n).padStart(2, '0');
    const body = days ? `${days}d ${h}h ${pad(m)}m` : `${h}h ${pad(m)}m ${pad(s)}s`;
    return left < 0 ? `${body} late` : `${body} left`;
  }

  function showCountdown() {
    const m = location.pathname.match(/\/mod\/(assign|quiz)\/view\.php$/);
    const cmid = Number(new URLSearchParams(location.search).get('id'));
    const event = m && cmid ? events.find((e) => e.cmid === cmid) : null;
    if (!settings.countdown || !event || sessionStorage.getItem(`sceleton-hide-${cmid}`)) {
      chip?.remove();
      chip = null;
      clearInterval(timer);
      return;
    }
    if (!chip) {
      chip = document.createElement('div');
      chip.id = 'sceleton-chip';
      chip.setAttribute('role', 'timer');
      chip.innerHTML = '<span class="sk-dot"></span><span class="sk-text"><b></b><small></small></span><button type="button" aria-label="Hide countdown">&times;</button>';
      chip.querySelector('button').addEventListener('click', () => {
        sessionStorage.setItem(`sceleton-hide-${cmid}`, '1');
        showCountdown();
      });
      document.body.appendChild(chip);
    }
    const due = new Date(event.time * 1000);
    chip.querySelector('small').textContent = `Due ${due.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}, ${due.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
    const tick = () => {
      const left = event.time - Date.now() / 1000;
      chip.dataset.heat = heat(left);
      chip.querySelector('b').textContent = fmtLeft(left);
    };
    tick();
    clearInterval(timer);
    timer = setInterval(tick, 1000);
  }
})();
