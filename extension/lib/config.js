// Where SCeLE lives. The dev build (dev/build-dev.mjs) swaps this for a
// local fake server so everything can be tested without a real account.
export const SCELE_URL = 'https://scele.cs.ui.ac.id';

// Where to look for new versions (see lib/update.js). Also swapped by the dev build.
export const RELEASES_URL = 'https://api.github.com/repos/zuromu/sceleton/releases/latest';
