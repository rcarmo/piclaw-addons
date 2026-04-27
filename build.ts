/**
 * build.ts — generates index.html + per-addon pages for piclaw-addons
 * Data source: catalog.json only (no external API calls)
 * Run: bun run build.ts
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { join, dirname } from "path";

const ROOT    = dirname(Bun.main);
const CATALOG = join(ROOT, "catalog.json");
const OUT     = join(ROOT, "docs");  // GitHub Pages serves from /docs

const SITE_URL  = "https://rcarmo.github.io/piclaw-addons";
const SITE_NAME = "piclaw-addons";
const ASSET_VER = Date.now().toString(36);

mkdirSync(OUT, { recursive: true });
mkdirSync(join(OUT, "addons"), { recursive: true });

// ── Types ─────────────────────────────────────────────────────────────────────
interface Install { kind: string; spec: string; piSource: string; }
interface Person { login: string; url: string; }
interface Addon {
  slug:         string;
  name:         string;
  version:      string;
  type:         string;
  description:  string;
  path:         string;
  tags:         string[];
  skills:       string[];
  install:      Install;
  owner?:        Person;
  contributors?: Person[];
  icon?:         string;
}
interface Catalog { version: number; source: string; addons: Addon[]; }

const catalog: Catalog = JSON.parse(readFileSync(CATALOG, "utf8"));
const addons  = catalog.addons;

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s: string) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function iconSrc(addon: Addon): string {
  // Per-addon icon first, then rotate through defaults by slug hash
  const specific = join(ROOT, "assets", "icons", addon.slug + ".png");
  if (existsSync(specific)) return `/piclaw-addons/assets/icons/${addon.slug}.png`;
  const n = addon.slug.split("").reduce((a, c) => a + c.charCodeAt(0), 0) % 5;
  return `/piclaw-addons/assets/icons/default-0${n}.png`;
}

function addonReadme(addon: Addon): string {
  const p = join(ROOT, addon.path, "README.md");
  if (!existsSync(p)) return "";
  return readFileSync(p, "utf8");
}

function mdToHtml(md: string): string {
  // Minimal markdown → HTML (headings, bullets, code, paragraphs)
  return md
    .replace(/^#{1} .+$/gm, "")                                           // strip h1 (already in hero)
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^#### (.+)$/gm, "<h4>$1</h4>")
    .replace(/```[\w]*\n([\s\S]*?)```/gm, "<pre><code>$1</code></pre>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/^\s*[-*] (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, "<ul>$1</ul>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/^(?!<[hup]|$)(.+)$/gm, "<p>$1</p>")
    .replace(/\n{2,}/g, "\n");
}

function tagBadge(tag: string) {
  return `<span class="badge">${esc(tag)}</span>`;
}

function personLink(p: Person, dim = false): string {
  return `<a href="${esc(p.url)}" target="_blank" rel="noopener" class="person-link${dim?' dim':''}">
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
    @${esc(p.login)}</a>`;
}

// Plain-text version for use inside <a> cards (no nested links)
function personChip(p: Person, dim = false): string {
  return `<span class="person-chip${dim?' dim':''}">
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
    @${esc(p.login)}</span>`;
}

function ownerRow(addon: Addon): string {
  if (!addon.owner) return "";
  const parts = [personLink(addon.owner)];
  for (const c of addon.contributors ?? []) parts.push(personLink(c, true));
  return `<div class="owner-row">${parts.join("")}</div>`;
}

// Card variant: chips only (no nested <a>)
function ownerChips(addon: Addon): string {
  if (!addon.owner) return "";
  const parts = [personChip(addon.owner)];
  for (const c of addon.contributors ?? []) parts.push(personChip(c, true));
  return `<div class="owner-row">${parts.join("")}</div>`;
}

function installSnippet(addon: Addon): string {
  if (addon.install?.piSource) {
    return `<div class="install-block">
      <span class="install-label">Install</span>
      <code class="install-cmd">${esc(addon.install.piSource)}</code>
      <button class="copy-btn" onclick="navigator.clipboard.writeText('${esc(addon.install.piSource)}')">Copy</button>
    </div>`;
  }
  return "";
}

// ── CSS ───────────────────────────────────────────────────────────────────────
const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#f0f4ff;
  --ink:#0f1c2e;
  --ink-dim:rgba(15,28,46,.6);
  --surface:#fff;
  --border:rgba(30,60,120,.12);
  --accent:#2563eb;
  --accent-bg:rgba(37,99,235,.07);
  --blue:#2563eb;
  --radius:14px;
  --font-head:'IBM Plex Sans','Inter',system-ui,sans-serif;
  --font-body:'Inter',system-ui,sans-serif;
  --font-mono:'JetBrains Mono','Fira Mono',monospace;
  --shadow:0 8px 32px rgba(15,28,46,.09);
}
@media(prefers-color-scheme:dark){
  :root{
    --bg:#0d1117;--ink:#e0e8f0;--ink-dim:rgba(224,232,240,.55);
    --surface:#141b27;--border:rgba(100,160,255,.13);
    --accent:#4f8cff;--accent-bg:rgba(79,140,255,.09);
  }
}
html,body{min-height:100%;background:var(--bg);color:var(--ink);font-family:var(--font-body);font-size:15px;line-height:1.65}

/* ── Hero ─── */
.hero{background:linear-gradient(135deg,#1e3a5f 0%,#2563eb 100%);color:#fff;padding:3rem 1.5rem 2.5rem;text-align:center}
.hero-logo{width:72px;height:72px;border-radius:18px;margin-bottom:1.2rem;box-shadow:0 8px 24px rgba(0,0,0,.25)}
.hero-title{font-family:var(--font-head);font-size:2.2rem;font-weight:800;letter-spacing:-.04em;margin-bottom:.5rem}
.hero-sub{font-size:1rem;opacity:.78;max-width:520px;margin:0 auto 1.4rem}
.hero-meta{font-size:.8rem;opacity:.55}
.hero-source{display:inline-flex;align-items:center;gap:.4rem;margin-top:.9rem;
  padding:.45rem .9rem;border-radius:10px;border:1px solid rgba(255,255,255,.25);
  color:rgba(255,255,255,.85);text-decoration:none;font-size:.78rem;font-weight:700}
.hero-source:hover{background:rgba(255,255,255,.1)}

/* ── Search ─── */
.search-bar{max-width:900px;margin:1.8rem auto .2rem;padding:0 1.25rem}
#search{width:100%;padding:.7rem 1rem;border-radius:10px;border:1.5px solid var(--border);
  background:var(--surface);color:var(--ink);font-size:.95rem;outline:none;font-family:var(--font-body)}
#search:focus{border-color:var(--accent)}

/* ── Grid ─── */
.grid{max-width:900px;margin:0 auto 3rem;padding:0 1.25rem;display:grid;
  grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:1rem}
.card{display:flex;flex-direction:column;gap:.5rem;padding:1.1rem;
  background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
  text-decoration:none;color:var(--ink);transition:box-shadow .15s,border-color .15s}
.card:hover{box-shadow:var(--shadow);border-color:var(--accent)}
.card-header{display:flex;align-items:center;gap:.7rem}
.card-icon{width:38px;height:38px;border-radius:9px;object-fit:contain;flex-shrink:0}
.card-name{font-family:var(--font-head);font-weight:700;font-size:.95rem;letter-spacing:-.02em}
.card-version{font-size:.72rem;color:var(--ink-dim);font-family:var(--font-mono);margin-top:.1rem}
.card-desc{font-size:.82rem;color:var(--ink-dim);line-height:1.5;flex:1}
.card-tags{display:flex;flex-wrap:wrap;gap:.3rem;margin-top:.3rem}
.badge{display:inline-block;padding:.18rem .5rem;border-radius:6px;font-size:.68rem;font-weight:700;
  letter-spacing:.04em;background:var(--accent-bg);color:var(--accent);text-transform:lowercase}
.card[hidden]{display:none}

/* ── Detail page ─── */
.detail-hero{background:linear-gradient(135deg,#1e3a5f 0%,#2563eb 100%);color:#fff;padding:2.5rem 1.5rem 2rem}
.detail-hero-inner{max-width:720px;margin:0 auto;display:flex;gap:1.4rem;align-items:flex-start}
.detail-icon{width:64px;height:64px;border-radius:16px;flex-shrink:0;box-shadow:0 6px 20px rgba(0,0,0,.2)}
.detail-title{font-family:var(--font-head);font-size:1.8rem;font-weight:800;letter-spacing:-.04em;margin-bottom:.35rem}
.detail-sub{font-size:.9rem;opacity:.78;line-height:1.5}
.detail-tags{display:flex;flex-wrap:wrap;gap:.35rem;margin-top:.8rem}
.detail-tags .badge{background:rgba(255,255,255,.15);color:#fff}
.detail-body{max-width:720px;margin:2rem auto 3rem;padding:0 1.5rem}
.detail-body h2{font-family:var(--font-head);font-size:1.15rem;font-weight:700;margin:1.8rem 0 .6rem;color:var(--ink)}
.detail-body h3{font-family:var(--font-head);font-size:1rem;font-weight:600;margin:1.2rem 0 .4rem}
.detail-body p{margin:.5rem 0;font-size:.9rem;color:var(--ink-dim)}
.detail-body ul{padding-left:1.4rem;margin:.4rem 0}
.detail-body li{font-size:.9rem;color:var(--ink-dim);margin:.2rem 0}
.detail-body pre{background:rgba(0,0,0,.04);border:1px solid var(--border);border-radius:8px;
  padding:.9rem 1rem;overflow-x:auto;margin:.6rem 0}
.detail-body code{font-family:var(--font-mono);font-size:.82rem}
.detail-body p code{background:rgba(0,0,0,.04);padding:.1em .35em;border-radius:4px}
.detail-body a{color:var(--accent)}
@media(prefers-color-scheme:dark){.detail-body pre{background:rgba(255,255,255,.04)}}

/* ── Install block ─── */
.install-block{display:flex;align-items:center;gap:.7rem;padding:.75rem 1rem;
  background:var(--accent-bg);border:1px solid var(--border);border-radius:10px;margin:1.2rem 0}
.install-label{font-size:.75rem;font-weight:800;text-transform:uppercase;letter-spacing:.07em;color:var(--accent);white-space:nowrap}
.install-cmd{font-family:var(--font-mono);font-size:.82rem;flex:1;word-break:break-all}
.copy-btn{padding:.3rem .7rem;border-radius:7px;border:1px solid var(--border);
  background:var(--surface);color:var(--ink-dim);font-size:.75rem;cursor:pointer;white-space:nowrap}
.copy-btn:hover{background:var(--accent);color:#fff;border-color:var(--accent)}

/* ── Back link ─── */
.back{display:inline-flex;align-items:center;gap:.4rem;color:rgba(255,255,255,.75);
  text-decoration:none;font-size:.82rem;font-weight:700;margin-bottom:1rem}
.back:hover{color:#fff}

/* ── Owner / contributors ─── */
.owner-row{display:flex;flex-wrap:wrap;gap:.35rem;margin-top:.45rem}
.person-link,.person-chip{display:inline-flex;align-items:center;gap:.28rem;padding:.18rem .5rem;
  border-radius:6px;border:1px solid var(--border);font-size:.74rem;font-weight:600;
  color:var(--ink-dim);text-decoration:none;background:var(--surface)}
.person-link:hover{background:var(--accent-bg);color:var(--accent);border-color:var(--accent)}
.person-link.dim,.person-chip.dim{opacity:.65}
.card .person-chip,.card .person-link{font-size:.68rem;padding:.13rem .4rem}

/* ── Footer ─── */
footer{text-align:center;padding:1.5rem;font-size:.75rem;color:var(--ink-dim);border-top:1px solid var(--border)}
footer a{color:var(--accent);text-decoration:none}
`;

// ── Index page ────────────────────────────────────────────────────────────────
const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>piclaw-addons</title>
<meta name="description" content="Community extensions, tools and add-ons for piclaw.">
<meta property="og:title" content="piclaw-addons">
<meta property="og:description" content="Community extensions, tools and add-ons for piclaw.">
<meta property="og:url" content="${SITE_URL}/">
<meta property="og:image" content="${SITE_URL}/assets/icons/piclaw.png">
<link rel="canonical" href="${SITE_URL}/">
<style>${CSS}</style>
</head>
<body>

<header class="hero">
  <img class="hero-logo" src="/piclaw-addons/assets/icons/piclaw.png" alt="piclaw">
  <div class="hero-title">piclaw-addons</div>
  <div class="hero-sub">Community extensions, tools and add-ons for <a href="https://github.com/rcarmo/piclaw" style="color:rgba(255,255,255,.85)">piclaw</a>.</div>
  <div class="hero-meta">${addons.length} add-ons &nbsp;·&nbsp; catalog v${catalog.version}</div>
  <a class="hero-source" href="https://github.com/rcarmo/piclaw-addons" target="_blank" rel="noopener">
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
    View on GitHub
  </a>
</header>

<div class="search-bar">
  <input id="search" type="search" placeholder="Search add-ons…" autocomplete="off">
</div>

<main class="grid" id="grid">
${addons.map(a => `  <a href="/piclaw-addons/addons/${esc(a.slug)}/" class="card" data-name="${esc(a.slug)} ${esc(a.description)} ${a.tags.join(" ")}">
    <div class="card-header">
      <img class="card-icon" src="${iconSrc(a)}" alt="" loading="lazy">
      <div>
        <div class="card-name">${esc(a.slug)}</div>
        <div class="card-version">v${esc(a.version)}</div>
      </div>
    </div>
    <div class="card-desc">${esc(a.description)}</div>
    <div class="card-tags">${a.tags.map(tagBadge).join("")}</div>
    ${ownerChips(a)}
  </a>`).join("\n")}
</main>

<footer>
  <a href="https://github.com/rcarmo/piclaw-addons">piclaw-addons</a> &nbsp;·&nbsp;
  <a href="https://github.com/rcarmo/piclaw">piclaw</a>
</footer>

<script>
const search = document.getElementById('search');
const cards  = [...document.querySelectorAll('.card')];
search.addEventListener('input', () => {
  const q = search.value.toLowerCase();
  cards.forEach(c => c.hidden = q && !c.dataset.name.toLowerCase().includes(q));
});
</script>
</body>
</html>`;

writeFileSync(join(OUT, "index.html"), indexHtml);
console.log(`✓ index.html (${addons.length} add-ons)`);

// ── Per-addon pages ────────────────────────────────────────────────────────────
let built = 0;
for (const addon of addons) {
  const dir = join(OUT, "addons", addon.slug);
  mkdirSync(dir, { recursive: true });

  const readme    = addonReadme(addon);
  const bodyHtml  = readme ? mdToHtml(readme) : `<p>${esc(addon.description)}</p>`;
  const skillList = addon.skills.length
    ? `<div class="detail-body"><h2>Skills</h2><ul>${addon.skills.map(s => `<li><code>${esc(s)}</code></li>`).join("")}</ul></div>`
    : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(addon.slug)} — piclaw-addons</title>
<meta name="description" content="${esc(addon.description)}">
<meta property="og:title" content="${esc(addon.slug)} — piclaw-addons">
<meta property="og:description" content="${esc(addon.description)}">
<meta property="og:url" content="${SITE_URL}/addons/${esc(addon.slug)}/">
<link rel="canonical" href="${SITE_URL}/addons/${esc(addon.slug)}/">
<style>${CSS}</style>
</head>
<body>

<div class="detail-hero">
  <div class="detail-hero-inner">
    <img class="detail-icon" src="${iconSrc(addon)}" alt="">
    <div>
      <a class="back" href="/piclaw-addons/">← all add-ons</a>
      <div class="detail-title">${esc(addon.slug)}</div>
      <div class="detail-sub">${esc(addon.description)}</div>
      <div class="detail-tags">${addon.tags.map(tagBadge).join("")}</div>
      ${ownerRow(addon)}
    </div>
  </div>
</div>

<div class="detail-body">
  ${installSnippet(addon)}
  ${bodyHtml}
</div>
${skillList}

<footer>
  <a href="/piclaw-addons/">piclaw-addons</a> &nbsp;·&nbsp;
  <a href="https://github.com/rcarmo/piclaw-addons/tree/main/${esc(addon.path)}">View source</a>
</footer>
</body>
</html>`;

  writeFileSync(join(dir, "index.html"), html);
  built++;
}
console.log(`✓ ${built} addon pages`);

// ── Copy assets ───────────────────────────────────────────────────────────────
// Assets are committed directly; no copy needed at build time.
console.log(`\nDone. Output → docs/`);
