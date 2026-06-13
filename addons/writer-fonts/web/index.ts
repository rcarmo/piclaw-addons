/**
 * writer-fonts — web entry
 *
 * Adds a font picker to the document editor status-bar footer and switches the
 * CodeMirror reading font — but ONLY in Markdown live-preview mode. Fonts are
 * bundled with the add-on (served from /agent/addons/assets/<pkg>/fonts) and
 * registered via @font-face. "System" and "Georgia" use OS fonts (not bundled).
 *
 * Behavior:
 *   - The chosen font is applied only while live preview is active (the reading
 *     surface, tables and frontmatter — code/mono surfaces stay monospace).
 *   - In plain/raw view the editor keeps its default monospace font, and the
 *     dropdown is disabled.
 *
 * Live-preview state is read from the editor's own status bar: the "Live
 * Preview" toggle button carries an `active` class when preview is on. We mirror
 * that onto a `wf-live` class on the `.editor-pane` and scope the override to it.
 *
 * Works in both frontends — the classic and visual UIs both mount the shared
 * editor bundle, which builds `.editor-pane` + the status bar.
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
const observedButtons = new WeakSet<Element>();

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
  } catch {
    /* ignore */
  }
}

/**
 * Plain/raw view must always be the editor's default monospace font. Earlier
 * versions wrote the chosen font into the editor's native font key; clear it so
 * non-preview editing reverts to the default monospace face everywhere.
 */
function clearNativeFontKey(): void {
  try {
    if (localStorage.getItem(NATIVE_KEY)) localStorage.removeItem(NATIVE_KEY);
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

/** Inject the picker chrome styling exactly once. */
function ensureChromeStyle(): void {
  if (document.getElementById("writer-fonts-chrome")) return;
  const style = document.createElement("style");
  style.id = "writer-fonts-chrome";
  style.textContent = `
.editor-status-actions .writer-fonts-control { display: inline-flex; align-items: center; }
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
.writer-fonts-select:disabled { opacity: 0.45; cursor: not-allowed; }
`;
  document.head.appendChild(style);
}

/**
 * Apply (or update) the live font override. Scoped to `.editor-pane.wf-live`
 * so it ONLY affects editors currently in live-preview mode. Specificity (the
 * extra `.wf-live` class) beats the live-preview markdown theme, which
 * hard-codes the system font with !important on `& .cm-scroller`,
 * `.cm-md-table-line`, `.cm-md-editable-table` and `.cm-md-frontmatter-value`.
 * Code/mono surfaces (.cm-md-*code*, table code cells) are left untouched.
 */
function applyFont(opt: FontOption): void {
  let style = document.getElementById("writer-fonts-active") as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = "writer-fonts-active";
    document.head.appendChild(style);
  }
  const ff = `${opt.stack} !important`;
  style.textContent = `
.editor-pane.wf-live .cm-editor,
.editor-pane.wf-live .cm-editor .cm-scroller,
.editor-pane.wf-live .cm-editor .cm-content,
.editor-pane.wf-live .cm-md-table-line,
.editor-pane.wf-live .cm-md-editable-table,
.editor-pane.wf-live .cm-md-frontmatter-value {
  font-family: ${ff};
}
`;
}

/** Build a <select> reflecting the current choice; on change apply + persist. */
function buildSelect(): HTMLSelectElement {
  const current = readChoice();
  const select = document.createElement("select");
  select.className = "writer-fonts-select";
  select.setAttribute("aria-label", "Editor font (live preview only)");
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

/** The "Live Preview" toggle button within a status-actions group, if present. */
function findLivePreviewButton(actions: Element): Element | null {
  return (
    Array.from(actions.querySelectorAll(".editor-status-button")).find(
      (b) => (b.textContent || "").trim() === "Live Preview",
    ) ?? null
  );
}

/** Is live preview currently active for the pane owning this status bar? */
function isLiveActive(actions: Element): boolean {
  const btn = findLivePreviewButton(actions);
  return !!btn && btn.classList.contains("active");
}

/**
 * Mirror live-preview state onto the pane (`wf-live`) and enable/disable the
 * picker accordingly.
 */
function refreshState(actions: HTMLElement): void {
  const pane = actions.closest(".editor-pane");
  const live = isLiveActive(actions);
  if (pane) pane.classList.toggle("wf-live", live);
  const select = actions.querySelector<HTMLSelectElement>(".writer-fonts-control .writer-fonts-select");
  if (select) {
    select.disabled = !live;
    select.title = live
      ? "Editor font (live preview)"
      : "Editor font — available in Live Preview only";
  }
}

/** Inject the picker into a status bar's actions group + wire live-preview state. */
function injectClassic(actions: HTMLElement): void {
  if (!actions.querySelector(":scope > .writer-fonts-control")) {
    const wrap = document.createElement("span");
    wrap.className = "writer-fonts-control";
    wrap.appendChild(buildSelect());
    actions.insertBefore(wrap, actions.firstChild);
  }
  // Observe the Live Preview button so toggles (click / Alt+P / context menu)
  // immediately update the picker + override gating.
  const lpBtn = findLivePreviewButton(actions);
  if (lpBtn && !observedButtons.has(lpBtn)) {
    observedButtons.add(lpBtn);
    const mo = new MutationObserver(() => refreshState(actions));
    mo.observe(lpBtn, { attributes: true, attributeFilter: ["class"] });
  }
  refreshState(actions);
}

/** Keep every editor picker in sync when one changes. */
function syncAllSelects(id: string): void {
  document.querySelectorAll<HTMLSelectElement>(".writer-fonts-select").forEach((sel) => {
    if (sel.value !== id) sel.value = id;
  });
}

function scanAndInject(): void {
  document.querySelectorAll<HTMLElement>(".editor-status-actions").forEach((el) => injectClassic(el));
}

function reapply(): void {
  ensureFontFaces();
  ensureChromeStyle();
  clearNativeFontKey();
  applyFont(readChoice());
  scanAndInject();
}

function init(): void {
  reapply();
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of Array.from(m.addedNodes)) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches?.(".editor-status-actions") || node.querySelector?.(".editor-status-actions")) {
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
window.addEventListener("piclaw:addons-loaded", () => {
  try {
    reapply();
  } catch {
    /* ignore */
  }
});

export {};
