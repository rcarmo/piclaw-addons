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
const CODE_COPY_RESET_MS = 1800;
const COPY_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="9" y="9" width="10" height="10" rx="2"></rect><path d="M7 15H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v1"></path></svg>';
const COPY_SUCCESS_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20 6L9 17l-5-5"></path></svg>';
const COPY_ERROR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"></circle><path d="M9 9l6 6M15 9l-6 6"></path></svg>';
const enhancedCodeBlocks = new WeakSet();

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

async function copyTextToClipboard(text) {
  const value = typeof text === 'string' ? text : '';
  if (!value) return false;

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {}
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const copied = document.execCommand('copy');
    document.body.removeChild(textarea);
    return copied;
  } catch {
    return false;
  }
}

function setCodeCopyButtonState(button, state) {
  if (!button) return;
  const nextState = state || 'idle';
  button.dataset.copyState = nextState;
  const icon = button.querySelector('.addon-code-copy-icon');
  const label = button.querySelector('.addon-code-copy-label');
  if (!icon || !label) return;

  if (nextState === 'success') {
    icon.innerHTML = COPY_SUCCESS_SVG;
    label.textContent = 'Copied';
    button.setAttribute('aria-label', 'Copied');
    button.setAttribute('title', 'Copied');
  } else if (nextState === 'error') {
    icon.innerHTML = COPY_ERROR_SVG;
    label.textContent = 'Failed';
    button.setAttribute('aria-label', 'Copy failed');
    button.setAttribute('title', 'Copy failed');
  } else {
    icon.innerHTML = COPY_ICON_SVG;
    label.textContent = 'Copy';
    button.setAttribute('aria-label', 'Copy code');
    button.setAttribute('title', 'Copy code');
  }
}

function enhanceCodeBlocks(root = document) {
  const blocks = Array.from(root.querySelectorAll('.addon-code-block'));
  for (const block of blocks) {
    if (enhancedCodeBlocks.has(block)) continue;
    enhancedCodeBlocks.add(block);

    const button = block.querySelector('.addon-code-copy-btn');
    const code = block.querySelector('pre code');
    if (!button || !code) continue;
    setCodeCopyButtonState(button, 'idle');

    let resetTimer = null;
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const ok = await copyTextToClipboard(code.textContent || '');
      setCodeCopyButtonState(button, ok ? 'success' : 'error');
      if (resetTimer) clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        setCodeCopyButtonState(button, 'idle');
        resetTimer = null;
      }, CODE_COPY_RESET_MS);
    });
  }
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
  enhanceCodeBlocks(document);
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
  enhanceCodeBlocks(document);
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
