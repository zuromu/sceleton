// Runs before the page paints so dark mode doesn't flash white first.
// The real setting lives in chrome.storage; this is just a fast copy.
try {
  const t = localStorage.getItem('sceleton-theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch (e) { /* storage blocked, the page will still pick the theme up a moment later */ }
