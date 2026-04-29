/**
 * build.ts — generates index.html + per-addon pages for piclaw-addons
 * Data source: catalog.json only (no external API calls)
 * Run: bun run build.ts
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync } from "fs";
import { join, dirname, normalize } from "path";
import { marked } from "marked";

const ROOT    = dirname(Bun.main);
const CATALOG = join(ROOT, "catalog.json");
const OUT     = join(ROOT, "docs");  // GitHub Pages serves from /docs

const SITE_URL  = "https://rcarmo.github.io/piclaw-addons";
const SITE_NAME = "piclaw-addons";
const ASSET_VER = Date.now().toString(36);
const PI_DEV_FOOTER_NOTE = `PiClaw is not affiliated with <a href="https://pi.dev" target="_blank" rel="noopener">pi.dev</a> — we’re just <em>huge fans</em>.`;

mkdirSync(OUT, { recursive: true });
mkdirSync(join(OUT, "addons"), { recursive: true });

// ── Types ─────────────────────────────────────────────────────────────────────
// First-party add-ons install from public GitHub Pages tarball URLs only.
// Do not add npm registry/auth fields back into the generated catalog model.
interface Install { kind: string; spec: string; }
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
  updatedAt?:   string;
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

function freshnessIndex(addon: Addon): number {
  // 05 — has open issues: needs attention
  if ((addon.openIssues ?? 0) > 0) return 5;
  // 05 — no tags: unclassified / missing metadata
  if (!addon.tags?.length) return 5;
  const updated = addon.updatedAt ? new Date(addon.updatedAt) : null;
  if (!updated || isNaN(updated.getTime())) return 4;
  const days = (Date.now() - updated.getTime()) / 86_400_000;
  if (days <=  3) return 0;  // new arrival (past 3 days)
  if (days <=  7) return 1;  // very recent
  if (days <= 14) return 2;  // recent
  if (days <= 30) return 3;  // maintained
  return 4;                  // least recently updated
}

function iconSrc(addon: Addon): string {
  const specific = join(ROOT, "assets", "icons", addon.slug + ".png");
  if (existsSync(specific)) return `/piclaw-addons/assets/icons/${addon.slug}.png`;
  return `/piclaw-addons/assets/icons/default-0${freshnessIndex(addon)}.png`;
}

function addonReadme(addon: Addon): string {
  const p = join(ROOT, addon.path, "README.md");
  if (!existsSync(p)) return "";
  return readFileSync(p, "utf8");
}

const CODE_COPY_ICON_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="9" y="9" width="10" height="10" rx="2"></rect><path d="M7 15H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v1"></path></svg>`;
const CODE_COPY_SUCCESS_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20 6L9 17l-5-5"></path></svg>`;
const CODE_COPY_ERROR_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"></circle><path d="M9 9l6 6M15 9l-6 6"></path></svg>`;

function normalizeCodeLanguageLabel(lang: string | null | undefined): string {
  const trimmed = String(lang || "").trim();
  if (!trimmed) return "text";
  const base = trimmed.split(/[\s,]+/, 1)[0] || trimmed;
  return base.toLowerCase();
}

const markdownRenderer = new marked.Renderer();
markdownRenderer.heading = function ({ tokens, depth }) {
  if (depth === 1) return "";
  return `<h${depth}>${this.parser.parseInline(tokens)}</h${depth}>`;
};
markdownRenderer.link = function ({ href, title, tokens }) {
  const text = this.parser.parseInline(tokens);
  const safeHref = typeof href === "string" ? esc(href) : "";
  if (!safeHref) return text;
  const safeTitle = typeof title === "string" && title ? ` title="${esc(title)}"` : "";
  return `<a href="${safeHref}" target="_blank" rel="noopener"${safeTitle}>${text}</a>`;
};
markdownRenderer.image = function ({ href, title, text }) {
  const safeHref = typeof href === "string" ? esc(href) : "";
  const safeAlt = esc(text || "");
  const safeTitle = typeof title === "string" && title ? ` title="${esc(title)}"` : "";
  return `<figure class="md-figure"><img src="${safeHref}" alt="${safeAlt}" loading="lazy"${safeTitle}></figure>`;
};
markdownRenderer.code = function ({ text, lang }) {
  const normalizedLang = normalizeCodeLanguageLabel(lang);
  const langClass = normalizedLang && normalizedLang !== "text" ? ` class="language-${esc(normalizedLang)}"` : "";
  return `<div class="addon-code-block"><div class="addon-code-block-header"><span class="addon-code-lang">${esc(normalizedLang)}</span><button type="button" class="addon-code-copy-btn" aria-label="Copy code" title="Copy code" data-copy-state="idle"><span class="addon-code-copy-icon" aria-hidden="true">${CODE_COPY_ICON_SVG}</span><span class="addon-code-copy-label">Copy</span></button></div><pre><code${langClass}>${esc(text)}</code></pre></div>`;
};

function mdToHtml(md: string): string {
  const tokens = marked.lexer(md, { gfm: true }) as any[];
  const filteredTokens = tokens.filter((token) => !(token?.type === "heading" && token?.depth === 1));
  return marked.parser(filteredTokens as any, {
    gfm: true,
    renderer: markdownRenderer,
  }) as string;
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
  const pkg = addon.install;
  return `<div class="install-block">
    <svg class="install-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z"/></svg>
    <span class="install-text">Open <strong>Settings → Add-Ons</strong> and pick <strong>${esc(addon.slug)}</strong></span>
  </div>`;
}

function renderFooter(content: string): string {
  return `<footer>
  <div class="footer-links">${content}</div>
  <div class="footer-note">${PI_DEV_FOOTER_NOTE}</div>
</footer>`;
}

function collectLocalReadmeAssetPaths(readme: string): string[] {
  const refs = new Set<string>();
  const add = (value: string) => {
    const trimmed = String(value || '').trim();
    if (!trimmed) return;
    if (/^(https?:|data:|mailto:|#)/i.test(trimmed)) return;
    if (trimmed.startsWith('/')) return;
    refs.add(trimmed);
  };
  for (const match of readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) add(match[1] || '');
  for (const match of readme.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) add(match[1] || '');
  return [...refs].sort();
}

function copyAddonReadmeAssets(addon: Addon, readme: string, outDir: string): void {
  const addonDir = join(ROOT, addon.path);
  for (const assetPath of collectLocalReadmeAssetPaths(readme)) {
    const normalized = normalize(assetPath).replace(/^\.\//, '');
    if (!normalized || normalized.startsWith('..')) continue;
    const src = join(addonDir, normalized);
    if (!existsSync(src)) continue;
    const dest = join(outDir, normalized);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }
}

// ── CSS ───────────────────────────────────────────────────────────────────────
const CLARITY_SCRIPT = `<script type="text/javascript">
(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window, document, "clarity", "script", "wipi60y9s3");
</script>`;

const CSS = `
@font-face{font-family:'IBM Plex Sans';src:url('/piclaw-addons/assets/fonts/ibm-plex-sans-400.woff2') format('woff2');font-weight:400;font-display:swap}
@font-face{font-family:'IBM Plex Sans';src:url('/piclaw-addons/assets/fonts/ibm-plex-sans-500.woff2') format('woff2');font-weight:500;font-display:swap}
@font-face{font-family:'IBM Plex Sans';src:url('/piclaw-addons/assets/fonts/ibm-plex-sans-600.woff2') format('woff2');font-weight:600;font-display:swap}
@font-face{font-family:'IBM Plex Sans';src:url('/piclaw-addons/assets/fonts/ibm-plex-sans-700.woff2') format('woff2');font-weight:700;font-display:swap}
@font-face{font-family:'Inter';src:url('/piclaw-addons/assets/fonts/inter-var.woff2') format('woff2');font-weight:100 900;font-display:swap}
@font-face{font-family:'JetBrains Mono';src:url('/piclaw-addons/assets/fonts/jetbrains-mono-400.woff2') format('woff2');font-weight:400;font-display:swap}
@font-face{font-family:'JetBrains Mono';src:url('/piclaw-addons/assets/fonts/jetbrains-mono-500.woff2') format('woff2');font-weight:500;font-display:swap}
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#f0f4ff;--ink:#0f1c2e;--ink-dim:rgba(15,28,46,.6);
  --surface:#fff;--border:rgba(30,60,120,.12);
  --accent:#2563eb;--accent-bg:rgba(37,99,235,.07);--blue:#2563eb;
  --radius:14px;--max-w:900px;
  --font-head:'IBM Plex Sans',system-ui,sans-serif;
  --font-body:'Inter',system-ui,sans-serif;
  --font-mono:'JetBrains Mono','Fira Mono',monospace;
  --shadow:0 8px 32px rgba(15,28,46,.09);
}
@media(prefers-color-scheme:dark){:root{
  --bg:#0d1117;--ink:#e0e8f0;--ink-dim:rgba(224,232,240,.55);
  --surface:#141b27;--border:rgba(100,160,255,.13);
  --accent:#4f8cff;--accent-bg:rgba(79,140,255,.09);
}}
html,body{min-height:100%;background:var(--bg);color:var(--ink);font-family:var(--font-body);font-size:16px;line-height:1.65}

/* ── Index hero ─── */
.hero{background:linear-gradient(135deg,#1e3a5f 0%,#2563eb 100%);color:#fff;padding:3.5rem 2rem 3rem}
.hero-inner{max-width:var(--max-w);margin:0 auto;display:flex;align-items:center;gap:2.5rem}
.hero-logo{width:240px;height:240px;border-radius:0;flex-shrink:0;object-fit:contain}
.hero-text{flex:1;min-width:0}
.hero-title{font-family:var(--font-head);font-size:3rem;font-weight:800;letter-spacing:-.045em;
  line-height:1.04;margin-bottom:.6rem}
.hero-sub{font-size:1.1rem;opacity:.78;max-width:540px;margin:0 0 1.4rem;line-height:1.6}
.hero-meta{font-size:.82rem;opacity:.55}
.hero-source{display:inline-flex;align-items:center;gap:.4rem;margin-top:1rem;
  padding:.5rem 1rem;border-radius:10px;border:1px solid rgba(255,255,255,.25);
  color:rgba(255,255,255,.85);text-decoration:none;font-size:.8rem;font-weight:700}
.hero-source:hover{background:rgba(255,255,255,.1)}
@media(max-width:640px){
  .hero-inner{flex-direction:column;text-align:center}
  .hero-logo{width:120px;height:120px}
  .hero-sub{margin:0 auto 1.4rem}
}

/* ── Search ─── */
.search-bar{max-width:var(--max-w);margin:2rem auto .4rem;padding:0 1.25rem}
#search{width:100%;padding:.75rem 1.1rem;border-radius:10px;border:1.5px solid var(--border);
  background:var(--surface);color:var(--ink);font-size:1rem;outline:none;font-family:var(--font-body)}
#search:focus{border-color:var(--accent)}

/* ── Grid ─── */
.grid{max-width:var(--max-w);margin:0 auto 3rem;padding:0 1.25rem;display:grid;
  grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:1.1rem}
.card{display:flex;flex-direction:column;gap:.55rem;padding:1.25rem;
  background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
  text-decoration:none;color:var(--ink);transition:box-shadow .15s,border-color .15s}
.card:hover{box-shadow:var(--shadow);border-color:var(--accent)}
.card-header{display:flex;align-items:center;gap:.85rem}
.card-icon{width:48px;height:48px;object-fit:contain;flex-shrink:0}
.card-name{font-family:var(--font-head);font-weight:700;font-size:1.05rem;letter-spacing:-.025em}
.card-sub-row{display:flex;align-items:center;gap:.45rem;flex-wrap:wrap;margin-top:.18rem}
.card-version{font-size:.72rem;color:var(--ink-dim);font-family:var(--font-mono)}
.card-sub-row .owner-row{margin:0}
.card-desc{font-size:.875rem;color:var(--ink-dim);line-height:1.55;flex:1}
.card-tags{display:flex;flex-wrap:wrap;gap:.3rem;margin-top:.35rem}
.badge{display:inline-block;padding:.2rem .55rem;border-radius:6px;font-size:.7rem;font-weight:700;
  letter-spacing:.04em;background:var(--accent-bg);color:var(--accent);text-transform:lowercase}
.card[hidden]{display:none}

/* ── Detail nav (pinned top-left) ─── */
.detail-nav{padding:.75rem 1.5rem;background:var(--bg);border-bottom:1px solid var(--border)}
.back{display:inline-flex;align-items:center;gap:.35rem;color:var(--accent);
  text-decoration:none;font-size:.82rem;font-weight:700}
.back:hover{text-decoration:underline}

/* ── Detail hero ─── */
.detail-hero{background:linear-gradient(135deg,#1e3a5f 0%,#2563eb 100%);color:#fff;padding:3.2rem 1.5rem 2.4rem}
.detail-hero-inner{max-width:760px;margin:0 auto;display:flex;gap:2rem;align-items:flex-start}
.detail-icon{width:180px;height:180px;border-radius:0;flex-shrink:0;object-fit:contain}
.detail-kicker{font-family:var(--font-head);font-size:.72rem;font-weight:800;letter-spacing:.1em;
  text-transform:uppercase;opacity:.6;margin-bottom:.55rem}
.detail-title{font-family:var(--font-head);font-size:clamp(2.2rem,4vw,3rem);font-weight:800;
  letter-spacing:-.045em;line-height:1.04;margin-bottom:.65rem}
.detail-sub{font-size:1.05rem;opacity:.8;line-height:1.6;max-width:55ch;margin-bottom:.9rem}
.detail-tags{display:flex;flex-wrap:wrap;gap:.35rem;margin-bottom:.75rem}
.detail-tags .badge{background:rgba(255,255,255,.16);color:#fff}
.detail-meta{display:flex;align-items:center;gap:.8rem;flex-wrap:wrap;margin-top:.55rem}
.detail-version{font-family:var(--font-mono);font-size:.78rem;opacity:.6}
.detail-type-row,.detail-title-row{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-bottom:.6rem}
.type-badge{display:inline-block;padding:.2rem .6rem;border-radius:6px;font-size:.72rem;
  font-weight:800;letter-spacing:.05em;text-transform:uppercase;
  background:rgba(255,255,255,.18);color:#fff;border:1px solid rgba(255,255,255,.25)}
.type-badge.skills{background:rgba(134,239,172,.2);border-color:rgba(134,239,172,.4);color:#bbf7d0}
.detail-issues{font-size:.76rem;font-weight:700;color:#fbbf24;background:rgba(251,191,36,.15);
  border:1px solid rgba(251,191,36,.3);padding:.18rem .5rem;border-radius:6px}
.issue-badge{display:inline-block;font-size:.7rem;font-weight:700;color:#f59e0b;
  background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.28);
  padding:.18rem .5rem;border-radius:6px;margin-top:.3rem}
.detail-body{max-width:760px;margin:2.2rem auto 3rem;padding:0 1.5rem}
.detail-body h2{font-family:var(--font-head);font-size:1.2rem;font-weight:700;margin:2rem 0 .65rem;color:var(--ink)}
.detail-body h3{font-family:var(--font-head);font-size:1rem;font-weight:600;margin:1.3rem 0 .45rem}
.detail-body p{margin:.55rem 0;font-size:.925rem;color:var(--ink-dim)}
.detail-body ul,.detail-body ol{padding-left:1.4rem;margin:.45rem 0}
.detail-body li{font-size:.925rem;color:var(--ink-dim);margin:.25rem 0}
.detail-body blockquote{margin:.9rem 0;padding:.15rem 0 .15rem 1rem;border-left:3px solid color-mix(in srgb, var(--accent) 45%, var(--border));color:var(--ink-dim);background:color-mix(in srgb, var(--accent-bg) 55%, transparent);border-radius:0 10px 10px 0}
.detail-body blockquote > :first-child{margin-top:0}
.detail-body blockquote > :last-child{margin-bottom:0}
.detail-body pre{background:rgba(0,0,0,.04);border:1px solid var(--border);border-radius:8px;
  padding:.95rem 1.1rem;overflow-x:auto;margin:.7rem 0}
.detail-body code{font-family:var(--font-mono);font-size:.83rem}
.addon-code-block{margin:.9rem 0;border:1px solid var(--border);border-radius:10px;overflow:hidden;background:color-mix(in srgb, var(--surface) 92%, var(--accent-bg))}
.addon-code-block-header{display:flex;align-items:center;justify-content:space-between;gap:.65rem;padding:.55rem .7rem;border-bottom:1px solid var(--border);background:color-mix(in srgb, var(--accent-bg) 35%, var(--surface))}
.addon-code-lang{display:inline-flex;align-items:center;min-width:0;font-family:var(--font-body);font-size:.72rem;line-height:1;text-transform:none;color:var(--ink-dim);letter-spacing:.02em}
.addon-code-copy-btn{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--border);border-radius:999px;padding:4px 9px;background:transparent;color:var(--ink-dim);font-size:.72rem;line-height:1;cursor:pointer;white-space:nowrap}
.addon-code-copy-btn:hover{background:color-mix(in srgb, var(--accent) 10%, transparent);border-color:color-mix(in srgb, var(--accent) 28%, var(--border));color:var(--ink)}
.addon-code-copy-btn:focus-visible{outline:none;box-shadow:0 0 0 2px color-mix(in srgb, var(--accent) 36%, transparent)}
.addon-code-copy-btn[data-copy-state="success"]{color:#10b981;border-color:color-mix(in srgb, #10b981 35%, var(--border))}
.addon-code-copy-btn[data-copy-state="error"]{color:#ef4444;border-color:color-mix(in srgb, #ef4444 35%, var(--border))}
.addon-code-copy-icon{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px}
.addon-code-copy-icon svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.addon-code-copy-label{font-weight:600}
.addon-code-block pre{margin:0;border:none;border-radius:0;background:transparent;padding:1rem 1.1rem;overflow-x:auto}
.addon-code-block pre code{background:none;padding:0;border:none;font-size:.82rem;display:block;white-space:pre}
.md-figure{margin:1rem 0}
.md-figure img,.detail-body p img,.detail-body li img{display:block;max-width:100%;height:auto;border-radius:10px;border:1px solid var(--border);box-shadow:var(--shadow)}
.md-table{width:100%;border-collapse:collapse;margin:.7rem 0;font-size:.9rem}
.md-table th,.md-table td{padding:.45rem .65rem;border:1px solid var(--border);text-align:left}
.md-table th{background:var(--accent-bg);font-family:var(--font-head);font-weight:600;font-size:.82rem}
.md-table td{color:var(--ink-dim)}
.md-table code{font-size:.78rem}
.detail-body :not(pre) > code{background:rgba(0,0,0,.04);padding:.1em .35em;border-radius:4px}
.detail-body a{color:var(--accent)}
@media(prefers-color-scheme:dark){.detail-body pre{background:rgba(255,255,255,.04)}}
@media(max-width:640px){
  .detail-hero-inner{flex-direction:column;align-items:center;text-align:center}
  .detail-icon{width:120px;height:120px}
  .detail-title{font-size:2rem}
  .detail-tags,.detail-meta,.owner-row{justify-content:center}
}

/* ── Install block ─── */
.install-block{display:flex;align-items:center;gap:.7rem;padding:.85rem 1.1rem;
  background:var(--accent-bg);border:1px solid var(--border);border-radius:10px;margin:1.4rem 0}
.install-icon{color:var(--accent);flex-shrink:0}
.install-text{font-size:.95rem;color:var(--ink-dim)}
.install-text strong{color:var(--ink)}
.install-alt{margin-top:.6rem;font-size:.85rem;color:var(--ink-dim)}
.install-alt summary{cursor:pointer;font-size:.82rem;color:var(--accent);font-weight:600;
  list-style:none;display:flex;align-items:center;gap:.3rem}
.install-alt summary::-webkit-details-marker{display:none}
.install-alt summary::before{content:'›';font-size:1rem;transition:transform .15s}
.install-alt[open] summary::before{transform:rotate(90deg)}
.install-alt pre{margin:.5rem 0 0;background:rgba(0,0,0,.04);border:1px solid var(--border);
  border-radius:8px;padding:.75rem 1rem;overflow-x:auto}
.install-alt code{font-family:var(--font-mono);font-size:.82rem;white-space:pre}
@media(prefers-color-scheme:dark){.install-alt pre{background:rgba(255,255,255,.04)}}

/* ── Owner / contributors ─── */
.owner-row{display:flex;flex-wrap:wrap;gap:.35rem;margin-top:.5rem}
.person-link,.person-chip{display:inline-flex;align-items:center;gap:.28rem;padding:.22rem .6rem;
  border-radius:7px;border:1px solid var(--border);font-size:.76rem;font-weight:600;
  color:var(--ink-dim);text-decoration:none;background:var(--surface)}
.person-link:hover{background:var(--accent-bg);color:var(--accent);border-color:var(--accent)}
.person-link.dim,.person-chip.dim{opacity:.65}
.detail-hero .person-chip,.detail-hero .person-link{background:rgba(255,255,255,.12);
  border-color:rgba(255,255,255,.22);color:rgba(255,255,255,.85)}
.detail-hero .person-link:hover{background:rgba(255,255,255,.22)}
.card .person-chip,.card .person-link{font-size:.69rem;padding:.13rem .42rem}

/* ── Footer ─── */
footer{text-align:center;padding:1.5rem;font-size:.76rem;color:var(--ink-dim);border-top:1px solid var(--border)}
footer a{color:var(--accent);text-decoration:none}
.footer-links{display:block}
.footer-note{margin-top:.55rem;max-width:46rem;margin-left:auto;margin-right:auto;line-height:1.55}
.footer-note em{font-style:italic}
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
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="piclaw-addons">
<meta name="twitter:description" content="Community extensions, tools and add-ons for piclaw.">
<meta name="twitter:image" content="${SITE_URL}/assets/icons/piclaw.png">
<link rel="canonical" href="${SITE_URL}/">
${CLARITY_SCRIPT}
<style>${CSS}</style>
</head>
<body>

<header class="hero">
  <div class="hero-inner">
    <img class="hero-logo" src="/piclaw-addons/assets/icons/piclaw.png" alt="piclaw">
    <div class="hero-text">
      <div class="hero-title">piclaw-addons</div>
      <div class="hero-sub">Community extensions, tools and add-ons for <a href="https://github.com/rcarmo/piclaw" style="color:rgba(255,255,255,.85)">piclaw</a>.</div>
      <div class="hero-meta">${addons.length} add-ons &nbsp;·&nbsp; catalog v${catalog.version}</div>
      <a class="hero-source" href="https://github.com/rcarmo/piclaw-addons" target="_blank" rel="noopener">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
        View on GitHub
      </a>
      <a class="hero-source" href="/piclaw-addons/packages/">↓ Packages</a>
    </div>
  </div>
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
        <div class="card-sub-row">
          <span class="card-version">v${esc(a.version)}</span>
          ${ownerChips(a)}
        </div>
      </div>
    </div>
    <div class="card-desc">${esc(a.description)}</div>
    <div class="card-tags">${a.tags.map(tagBadge).join("")}</div>
  </a>`).join("\n")}
</main>

${renderFooter(`<a href="https://github.com/rcarmo/piclaw-addons">piclaw-addons</a> &nbsp;·&nbsp;
  <a href="https://github.com/rcarmo/piclaw">piclaw</a>`)}

<script>
const search = document.getElementById('search');
const cards  = [...document.querySelectorAll('.card')];
search.addEventListener('input', () => {
  const q = search.value.toLowerCase();
  cards.forEach(c => c.hidden = q && !c.dataset.name.toLowerCase().includes(q));
});
</script>
<script type="module">
  import { mountIndex } from '/piclaw-addons/assets/js/addon-island.mjs';
  mountIndex();
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
  if (readme) copyAddonReadmeAssets(addon, readme, dir);
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
<meta property="og:image" content="${SITE_URL}/${iconSrc(addon).replace('/piclaw-addons/', '')}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(addon.slug)} — piclaw-addons">
<meta name="twitter:description" content="${esc(addon.description)}">
<meta name="twitter:image" content="${SITE_URL}/${iconSrc(addon).replace('/piclaw-addons/', '')}">
<link rel="canonical" href="${SITE_URL}/addons/${esc(addon.slug)}/">
${CLARITY_SCRIPT}
<style>${CSS}</style>
</head>
<body>

<nav class="detail-nav">
  <a href="/piclaw-addons/" class="back">← all add-ons</a>
</nav>

<div class="detail-hero">
  <div class="detail-hero-inner">
    <img class="detail-icon" src="${iconSrc(addon)}" alt="">
    <div>
      <div class="detail-title-row">
        <div class="detail-title">${esc(addon.slug)}</div>
        <span class="type-badge">${esc(addon.type)}</span>
        ${addon.skills.length ? `<span class="type-badge skills">${addon.skills.length} skill${addon.skills.length!==1?'s':''}</span>` : ''}
      </div>
      <div class="detail-sub">${esc(addon.description)}</div>
      <div class="detail-tags">${addon.tags.map(tagBadge).join("")}</div>
      <div class="detail-meta">
        <span class="detail-version">v${esc(addon.version)}</span>
        ${addon.openIssues ? `<span class="detail-issues">${addon.openIssues} open issue${addon.openIssues!==1?'s':''}</span>` : ''}
        ${ownerRow(addon)}
      </div>
    </div>
  </div>
</div>

<div class="detail-body">
  ${installSnippet(addon)}
  ${bodyHtml}
</div>
${skillList}

${renderFooter(`<a href="/piclaw-addons/">piclaw-addons</a> &nbsp;·&nbsp;
  <a href="https://github.com/rcarmo/piclaw-addons/tree/main/${esc(addon.path)}">View source</a>`)}
<script type="module">
  import { mountDetail } from '/piclaw-addons/assets/js/addon-island.mjs';
  mountDetail('${esc(addon.slug)}');
</script>
</body>
</html>`;

  writeFileSync(join(dir, "index.html"), html);
  built++;
}
console.log(`✓ ${built} addon pages`);

// ── Pack tarballs ─────────────────────────────────────────────────────────────
mkdirSync(join(OUT, "packages"), { recursive: true });
for (const addon of addons) {
  const addonDir = join(ROOT, addon.path);
  const baseName = addon.name.replace(/^@[^/]+\//, '');
  const outPath  = join(OUT, "packages", `${baseName}-${addon.version}.tgz`);
  Bun.spawnSync(["tar", "czf", outPath, "-C", addonDir, "."], {
    stdout: "inherit",
    stderr: "inherit",
  });
  console.log(`✓ packed ${addon.name}@${addon.version}`);
}

// ── Packages index page ───────────────────────────────────────────────────────
const pkgsHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Packages — piclaw-addons</title>
<meta name="description" content="Downloadable add-on packages for piclaw.">
<link rel="canonical" href="${SITE_URL}/packages/">
${CLARITY_SCRIPT}
<style>${CSS}</style>
</head>
<body>
<nav class="detail-nav"><a href="/piclaw-addons/" class="back">← all add-ons</a></nav>
<div class="detail-hero" style="padding:2rem 1.5rem 1.8rem">
  <div style="max-width:760px;margin:0 auto">
    <div class="detail-title" style="font-size:2rem">Packages</div>
    <div class="detail-sub">Direct-download tarballs — one per add-on. These public GitHub Pages URLs are the supported first-party install path for Settings → Add-Ons and terminal installs.</div>
  </div>
</div>
<div class="detail-body">
  <table style="width:100%;border-collapse:collapse;font-size:.9rem">
    <thead>
      <tr style="border-bottom:2px solid var(--border)">
        <th style="text-align:left;padding:.6rem .5rem;font-family:var(--font-head)">Add-on</th>
        <th style="text-align:left;padding:.6rem .5rem;font-family:var(--font-head)">Version</th>
        <th style="text-align:left;padding:.6rem .5rem;font-family:var(--font-head)">Install</th>
        <th style="text-align:right;padding:.6rem .5rem;font-family:var(--font-head)">.tgz</th>
      </tr>
    </thead>
    <tbody>
      ${addons.map(a => {
        const baseName = a.name.replace(/^@[^/]+\//, '');
        const url = `${SITE_URL}/packages/${esc(baseName)}-${esc(a.version)}.tgz`;
        return `<tr style="border-bottom:1px solid var(--border)">
          <td style="padding:.55rem .5rem"><a href="/piclaw-addons/addons/${esc(a.slug)}/" style="color:var(--accent);font-weight:600">${esc(a.slug)}</a></td>
          <td style="padding:.55rem .5rem;font-family:var(--font-mono);color:var(--ink-dim)">v${esc(a.version)}</td>
          <td style="padding:.55rem .5rem"><span style="font-size:.82rem;color:var(--ink-dim)">Settings → Add-Ons → <strong>${esc(a.slug)}</strong></span></td>
          <td style="padding:.55rem .5rem;text-align:right"><a href="${url}" style="color:var(--accent);font-weight:700;font-size:.82rem">⬇ .tgz</a></td>
        </tr>`;
      }).join("\n")}
    </tbody>
  </table>
</div>
${renderFooter(`<a href="/piclaw-addons/">piclaw-addons</a>`)}
</body>
</html>`;

writeFileSync(join(OUT, "packages", "index.html"), pkgsHtml);
console.log(`✓ packages/index.html`);

// ── Copy static assets ──────────────────────────────────────────────────────
import { copyFileSync } from "fs";
copyFileSync(join(ROOT, "assets", "event-sequence.svg"), join(OUT, "event-sequence.svg"));

console.log(`\nDone. Output → docs/`);
