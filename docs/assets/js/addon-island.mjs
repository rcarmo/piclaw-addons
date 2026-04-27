/**
 * addon-island.mjs — live GitHub issue counts for piclaw-addons
 *
 * Vanilla JS only. Mirrors the caching/fetch pattern from rcarmo.github.io.
 * Fetches open issues for rcarmo/piclaw-addons once per session,
 * groups them by addon:<slug> labels, then:
 *   - Swaps card/detail icons to default-05.png for addons with open issues
 *   - Shows an issue-count badge on affected cards and detail pages
 */

const REPO        = 'rcarmo/piclaw-addons';
const API_BASE    = 'https://api.github.com';
const CACHE_KEY   = 'piclaw_addons_issues';
const CACHE_TTL   = 15 * 60 * 1000;  // 15 min
const ICON_PREFIX = '/piclaw-addons/assets/icons/';
const ALERT_ICON  = `${ICON_PREFIX}default-05.png`;

// ── Session cache ─────────────────────────────────────────────────────────────
function getCache() {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (Date.now() - ts > CACHE_TTL) return null;
    return data;
  } catch { return null; }
}
function setCache(data) {
  try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data })); } catch {}
}

// ── Fetch all open issues, group by addon slug ────────────────────────────────
async function fetchIssueCounts() {
  const cached = getCache();
  if (cached) return cached;

  // Fetch up to 100 open issues (enough for any real project)
  const url = `${API_BASE}/repos/${REPO}/issues?state=open&per_page=100`;
  const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) return {};

  const issues = await res.json();
  const counts = {};
  for (const issue of issues) {
    for (const label of issue.labels ?? []) {
      const m = label.name?.match(/^addon:(.+)$/);
      if (m) counts[m[1]] = (counts[m[1]] ?? 0) + 1;
    }
  }

  setCache(counts);
  return counts;
}

// ── Apply to index page (card grid) ──────────────────────────────────────────
export function mountIndex() {
  fetchIssueCounts().then(counts => {
    if (!Object.keys(counts).length) return;

    for (const [slug, n] of Object.entries(counts)) {
      // Find card by data-name prefix match
      const card = document.querySelector(`.card[data-name^="${slug} "], .card[data-name="${slug}"]`);
      if (!card) continue;

      // Swap icon
      const img = card.querySelector('.card-icon');
      if (img) img.src = ALERT_ICON;

      // Add issue badge if not already there
      if (!card.querySelector('.issue-badge')) {
        const badge = document.createElement('span');
        badge.className = 'issue-badge';
        badge.textContent = `${n} open issue${n !== 1 ? 's' : ''}`;
        const tags = card.querySelector('.card-tags');
        if (tags) tags.after(badge);
      }
    }
  }).catch(() => {});
}

// ── Apply to detail page ──────────────────────────────────────────────────────
export function mountDetail(slug) {
  fetchIssueCounts().then(counts => {
    const n = counts[slug];
    if (!n) return;

    // Swap hero icon
    const img = document.querySelector('.detail-icon');
    if (img) img.src = ALERT_ICON;

    // Update or create issue count element
    let el = document.querySelector('.detail-issues');
    if (!el) {
      el = document.createElement('span');
      el.className = 'detail-issues';
      const meta = document.querySelector('.detail-meta');
      if (meta) meta.appendChild(el);
    }
    el.textContent = `${n} open issue${n !== 1 ? 's' : ''}`;
  }).catch(() => {});
}
