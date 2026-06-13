/**
 * writer-fonts — web entry
 *
 * Adds a font picker to the document editor footer and live-switches the
 * CodeMirror editor font between a curated set of writing faces. Fonts are
 * bundled with the add-on (served from /agent/addons/assets/<pkg>/fonts) and
 * registered via @font-face. "System" and "Georgia" use OS fonts (not bundled).
 *
 * Supports both editor frontends:
 *   - classic UI: control is injected into the status bar (`.editor-status-actions`)
 *   - visual  UI: a footer row is appended to `.editor-frame`
 *
 * The choice persists in localStorage under our own key and the editor's native
 * `piclaw_editor_font_family` key, so a reload / freshly opened file tab keeps
 * the same font even before this script re-applies the live override.
 */

const PKG = "@rcarmo/piclaw-addon-writer-fonts";
const ASSET = (file: string): string =>
  `/agent/addons/assets/${encodeURIComponent(PKG)}/fonts/${encodeURIComponent(file)}`;

const SYSTEM_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

interface Bundled {
  family: string;
  file: string;
  variable: boolean;
}
interface FontOption {
  id: string;
  label: string;
  stack: string;
  bundled: Bundled | null;
}

const FONTS: FontOption[] = [
  { id: "system", label: "System", stack: SYSTEM_STACK, bundled: null },
  {
    id: "literata",
    label: "Literata",
    stack: '"Literata", Georgia, "Times New Roman", serif',
    bundled: { family: "Literata", file: "Literata-var.woff2", variable: true },
  },
  {
    id: "georgia",
    label: "Georgia",
    stack: 'Georgia, "Times New Roman", serif',
    bundled: null,
  },
  {
    id: "inter",
    label: "Inter",
    stack: '"Inter", system-ui, sans-serif',
    bundled: { family: "Inter", file: "Inter-var.woff2", variable: true },
  },
  {
    id: "notosans",
    label: "Noto Sans",
    stack: '"Noto Sans", system-ui, sans-serif',
    bundled: { family: "Noto Sans", file: "NotoSans-var.woff2", variable: true },
  },
  {
    id: "notosanstc",
    label: "Noto Sans TC",
    stack: '"Noto Sans TC", "Noto Sans", system-ui, sans-serif',
    bundled: { family: "Noto Sans TC", file: "NotoSansTC-var.woff2", variable: true },
  },
  {
    id: "newtegomin",
    label: "New Tegomin",
    stack: '"New Tegomin", "Noto Serif", serif',
    bundled: { family: "New Tegomin", file: "NewTegomin-Regular.woff2", variable: false },
  },
  {
    id: "ibmplexsans",
    label: "IBM Plex Sans",
    stack: '"IBM Plex Sans", system-ui, sans-serif',
    bundled: { family: "IBM Plex Sans", file: "IBMPlexSans-var.woff2", variable: true },
  },
];

const STORAGE_KEY = "piclaw_writer_font";
const NATIVE_KEY = "piclaw_editor_font_family";
const DEFAULT_ID = "system";

function optionById(id: string | null): FontOption {
  return FONTS.find((f) => f.id === id) ?? FONTS[0];
}

function readChoice(): FontOption {
  let id: string | null = null;
  try {
    id = localStorage.getItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  return optionById(id ?? DEFAULT_ID);
}

function persistChoice(opt: FontOption): void {
  try {
    localStorage.setItem(STORAGE_KEY, opt.id);
    // Keep the editor's native setting in sync so reloaded/new file tabs match
    // even before this script re-applies the live override.
    localStorage.setItem(NATIVE_KEY, opt.id === "system" ? "" : opt.stack);
  } catch {
    /* ignore */
  }
}

/** Inject the @font-face rules for every bundled font exactly once. */
function ensureFontFaces(): void {
  if (document.getElementById("writer-fonts-faces")) return;
  const faces = FONTS.filter((f) => f.bundled)
    .map((f) => {
      const b = f.bundled as Bundled;
      const weight = b.variable ? "100 900" : "400";
      return [
        "@font-face {",
        `  font-family: "${b.family}";`,
        `  src: url("${ASSET(b.file)}") format("woff2");`,
        `  font-weight: ${weight};`,
        "  font-style: normal;",
        "  font-display: swap;",
        "}",
      ].join("\n");
    })
    .join("\n");
  const style = document.createElement("style");
  style.id = "writer-fonts-faces";
  style.textContent = faces;
  document.head.appendChild(style);
}

/** Inject the picker / footer chrome styling exactly once. */
function ensureChromeStyle(): void {
  if (document.getElementById("writer-fonts-chrome")) return;
  const style = document.createElement("style");
  style.id = "writer-fonts-chrome";
  style.textContent = `
/* classic UI: a select styled to match .editor-status-button in the status bar */
.editor-status-actions .writer-fonts-control {
  display: inline-flex;
  align-items: center;
}
.writer-fonts-select {
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 4px;
  padding: 1px 5px;
  font: inherit;
  font-size: 10px;
  max-width: 160px;
}
.writer-fonts-select:hover { color: var(--text-primary, inherit); }
.writer-fonts-select:focus { outline: 1px solid var(--accent-color, #6ea8fe); }

/* visual UI: a footer row appended to .editor-frame */
.editor-frame .writer-fonts-footer {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  border-top: 1px solid var(--border-color, rgba(127,127,127,0.25));
  background: var(--panel-bg, var(--bg-secondary, transparent));
  font-family: var(--font-family, ${SYSTEM_STACK});
  font-size: 12px;
}
.editor-frame .writer-fonts-footer .writer-fonts-label {
  opacity: 0.7;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  font-size: 10px;
}
.editor-frame .writer-fonts-footer .writer-fonts-select {
  max-width: 240px;
  padding: 2px 6px;
  font-size: 12px;
}
`;
  document.head.appendChild(style);
}

/** Apply (or update) the live font override on the document editor. */
function applyFont(opt: FontOption): void {
  let style = document.getElementById("writer-fonts-active") as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = "writer-fonts-active";
    document.head.appendChild(style);
  }
  style.textContent = `
.editor-pane .cm-editor,
.editor-pane .cm-scroller,
.editor-pane .cm-content,
.editor-frame .cm-editor,
.editor-frame .cm-scroller,
.editor-frame .cm-content {
  font-family: ${opt.stack} !important;
}
`;
}

/** Build a <select> reflecting the current choice; on change apply + persist. */
function buildSelect(): HTMLSelectElement {
  const current = readChoice();
  const select = document.createElement("select");
  select.className = "writer-fonts-select";
  select.title = "Editor font";
  select.setAttribute("aria-label", "Editor font");
  for (const f of FONTS) {
    const o = document.createElement("option");
    o.value = f.id;
    o.textContent = f.label;
    if (f.id === current.id) o.selected = true;
    select.appendChild(o);
  }
  select.addEventListener("change", () => {
    const opt = optionById(select.value);
    persistChoice(opt);
    applyFont(opt);
    syncAllSelects(opt.id);
  });
  return select;
}

/** classic UI: inject the picker into a status bar's actions group. */
function injectClassic(actions: HTMLElement): void {
  if (actions.querySelector(":scope > .writer-fonts-control")) return;
  const wrap = document.createElement("span");
  wrap.className = "writer-fonts-control";
  wrap.appendChild(buildSelect());
  actions.insertBefore(wrap, actions.firstChild);
}

/** visual UI: append a footer row with the picker to an editor frame. */
function injectVisual(frame: HTMLElement): void {
  if (frame.querySelector(":scope > .writer-fonts-footer")) return;
  const footer = document.createElement("div");
  footer.className = "writer-fonts-footer";
  const label = document.createElement("label");
  label.className = "writer-fonts-label";
  label.textContent = "Font";
  const select = buildSelect();
  const id = `wf-${Math.random().toString(36).slice(2, 8)}`;
  label.setAttribute("for", id);
  select.id = id;
  footer.appendChild(label);
  footer.appendChild(select);
  frame.appendChild(footer);
}

/** Keep every editor picker in sync when one changes. */
function syncAllSelects(id: string): void {
  document.querySelectorAll<HTMLSelectElement>(".writer-fonts-select").forEach((sel) => {
    if (sel.value !== id) sel.value = id;
  });
}

function scanAndInject(): void {
  document.querySelectorAll<HTMLElement>(".editor-status-actions").forEach((el) => injectClassic(el));
  document.querySelectorAll<HTMLElement>(".editor-frame").forEach((el) => injectVisual(el));
}

function reapply(): void {
  ensureFontFaces();
  ensureChromeStyle();
  applyFont(readChoice());
  scanAndInject();
}

function init(): void {
  reapply();
  // Editor panes mount/unmount as files open and close; watch for them.
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of Array.from(m.addedNodes)) {
        if (!(node instanceof HTMLElement)) continue;
        if (
          node.matches?.(".editor-status-actions, .editor-frame") ||
          node.querySelector?.(".editor-status-actions, .editor-frame")
        ) {
          scanAndInject();
        }
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
// Re-run after the add-on layer announces itself, in case we loaded early.
window.addEventListener("piclaw:addons-loaded", () => {
  try {
    reapply();
  } catch {
    /* ignore */
  }
});

export {};
