/**
 * writer-fonts — web entry
 *
 * Adds a font-picker dropdown to the document editor footer and live-switches
 * the CodeMirror editor font between a curated set of writing faces. Fonts are
 * bundled with the add-on (served from /agent/addons/assets/<pkg>/fonts) and
 * registered via @font-face. "System" and "Georgia" use OS fonts (not bundled).
 *
 * The choice persists in localStorage under both our own key and the editor's
 * native `piclaw_editor_font_family` key, so a reload / freshly opened file tab
 * keeps the same font even before this script re-applies the live override.
 *
 * Scope: the in-app document editor only (`.editor-frame` → CodeMirror). Other
 * CodeMirror instances (e.g. the plan sidebar) are intentionally untouched.
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
    label: "Noto Sans Traditional Chinese",
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

/** Inject the footer / dropdown chrome styling exactly once. */
function ensureChromeStyle(): void {
  if (document.getElementById("writer-fonts-chrome")) return;
  const style = document.createElement("style");
  style.id = "writer-fonts-chrome";
  style.textContent = `
.writer-fonts-footer {
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
.writer-fonts-footer .writer-fonts-label {
  opacity: 0.7;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  font-size: 10px;
}
.writer-fonts-footer .writer-fonts-select {
  flex: 0 1 auto;
  max-width: 240px;
  padding: 2px 6px;
  border-radius: 5px;
  border: 1px solid var(--border-color, rgba(127,127,127,0.3));
  background: var(--input-bg, var(--bg-primary, transparent));
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.writer-fonts-footer .writer-fonts-select:focus {
  outline: 1px solid var(--accent-color, #6ea8fe);
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
.editor-frame .cm-editor,
.editor-frame .cm-scroller,
.editor-frame .cm-content {
  font-family: ${opt.stack} !important;
}
`;
}

/** Build the <select> footer control inside one editor frame. */
function injectFooter(frame: HTMLElement): void {
  if (frame.querySelector(":scope > .writer-fonts-footer")) return;
  const current = readChoice();

  const footer = document.createElement("div");
  footer.className = "writer-fonts-footer";

  const label = document.createElement("label");
  label.className = "writer-fonts-label";
  label.textContent = "Font";

  const select = document.createElement("select");
  select.className = "writer-fonts-select";
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

  const id = `wf-${Math.random().toString(36).slice(2, 8)}`;
  label.setAttribute("for", id);
  select.id = id;

  footer.appendChild(label);
  footer.appendChild(select);
  frame.appendChild(footer);
}

/** Keep every editor footer's dropdown in sync when one changes. */
function syncAllSelects(id: string): void {
  document.querySelectorAll<HTMLSelectElement>(".writer-fonts-footer .writer-fonts-select").forEach((sel) => {
    if (sel.value !== id) sel.value = id;
  });
}

function scanAndInject(): void {
  document.querySelectorAll<HTMLElement>(".editor-frame").forEach((frame) => injectFooter(frame));
}

function init(): void {
  ensureFontFaces();
  ensureChromeStyle();
  applyFont(readChoice());
  scanAndInject();

  // Editor frames mount/unmount as files open and close; watch for them.
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of Array.from(m.addedNodes)) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.classList?.contains("editor-frame")) {
          injectFooter(node);
        } else if (node.querySelector?.(".editor-frame")) {
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
    ensureFontFaces();
    ensureChromeStyle();
    applyFont(readChoice());
    scanAndInject();
  } catch {
    /* ignore */
  }
});

export {};
