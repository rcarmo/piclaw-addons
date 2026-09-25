import { expect, test } from "bun:test";
import { actionStyles, styles } from "./web/styles.ts";

const normalize = (css: string) => css.replace(/\s+/g, " ").trim();

// Package-local contract assertions; standalone tests must not read another checkout.
const sharedScopedActionSnapshot = [
  "padding: 6px 14px !important;",
  "border-radius: 6px !important;",
  "font-family: var(--font-family, system-ui, sans-serif) !important;",
  "background: var(--bg-hover, var(--bg-secondary)) !important;",
  "outline: 2px solid var(--accent-color) !important;",
  "color: var(--accent-contrast-text, #fff) !important;",
].join("\n\n");

const classicActionSnapshot = `
.cr-pane[data-skin=classic] {
    --settings-addon-button-min-height: auto;
    --settings-addon-button-min-width: 70px;
    --settings-addon-button-font-size: calc(var(--font-size-md, 15px) * 0.84);
    --settings-addon-button-font-weight: normal;
    --settings-addon-button-line-height: normal;
    --settings-addon-button-white-space: nowrap;
    --settings-addon-button-transition: all 0s;
    --settings-addon-button-hover-border: var(--border-color, rgba(128,128,128,0.3));
    --settings-addon-button-disabled-opacity: 0.5;
    --settings-addon-button-disabled-cursor: pointer;
}

.cr-pane[data-skin=classic] :where(button:not(.settings-number-step-btn):not(.settings-panel__stepper-btn):not([role="tab"]):not([role="switch"]):not([data-settings-button="unstyled"])) {
    font-family: revert !important;
}

@media (max-width: 640px) {
    .cr-pane[data-skin=classic] {
        --settings-addon-button-font-size: calc(var(--font-size-md, 15px) * 0.9 * 0.84);
    }
}
`;

test("actionStyles keeps the shared settings button contract and adds classic overrides", () => {
  const css = normalize(actionStyles);
  for (const block of sharedScopedActionSnapshot
    .split(/\n\s*\n/)
    .map(normalize)
    .filter(Boolean))
    expect(css).toContain(block);
  expect(css).toContain(normalize(classicActionSnapshot));
  expect(css).toContain(
    normalize(`
      .cr-pane :where(button:not(.settings-number-step-btn):not(.settings-panel__stepper-btn):not([role="tab"]):not([role="switch"]):not([data-settings-button="unstyled"]))[aria-pressed="true"] {
          background: var(--accent-soft, color-mix(in srgb, var(--accent-color) 12%, transparent)) !important;
          border-color: var(--accent-color) !important;
      }
    `),
  );
});

test("styles preserve source sizing and icon control geometry", () => {
  const css = normalize(styles);
  expect(css).toContain(
    normalize(`
      .cr-line{display:grid;grid-template-columns:24px 42px 18px minmax(0,1fr);min-width:max-content;font:12px/18px var(--font-family-mono,monospace);padding:0;min-height:18px}
    `),
  );
  expect(css).toContain(
    normalize(`
      .cr-line>button{font:11px/18px var(--font-family-mono,monospace);height:18px;min-height:0;border:0;padding:0 3px;background:transparent;color:var(--text-secondary);border-radius:0}
    `),
  );
  expect(css).toContain(
    normalize(`
      .cr-pane button[data-settings-button=icon]{width:32px!important;min-width:32px!important;height:32px!important;min-height:32px!important;display:inline-flex;align-items:center;justify-content:center;flex:0 0 32px;padding:6px!important;line-height:18px!important}
    `),
  );
  expect(css).toContain(
    normalize(`
      .cr-pane{ --green:var(--success-color); --green-bg:color-mix(in srgb,#2da44e 14%,var(--bg-code,var(--bg-primary))); --red:var(--danger-color); --red-bg:color-mix(in srgb,#cf222e 12%,var(--bg-code,var(--bg-primary))); --cr-add:var(--green-bg); --cr-del:var(--red-bg);
    `),
  );
});

test("styles map code-review tokens to the host syntax-role contract without loose precedence leaks", () => {
  const css = normalize(styles);
  for (const selector of [
    ".cr-pane .tok-keyword{",
    ".cr-pane .tok-string,.cr-pane .tok-string2{",
    ".cr-pane .tok-regexp{",
    ".cr-pane .tok-number{",
    ".cr-pane .tok-bool{",
    ".cr-pane .tok-atom{",
    ".cr-pane .tok-labelName{",
    ".cr-pane .tok-variableName{",
    ".cr-pane .tok-variableName.tok-definition{",
    ".cr-pane .tok-variableName.tok-local{",
    ".cr-pane .tok-variableName2{",
    ".cr-pane .tok-propertyName{",
    ".cr-pane .tok-propertyName.tok-definition{",
    ".cr-pane :is(.tok-variableName,.tok-propertyName).tok-function{",
    ".cr-pane .tok-typeName{",
    ".cr-pane .tok-className{",
    ".cr-pane .tok-namespace{",
    ".cr-pane .tok-macroName{",
    ".cr-pane .tok-comment{",
    ".cr-pane .tok-meta{",
    ".cr-pane .tok-operator{",
    ".cr-pane .tok-punctuation{",
    ".cr-pane .tok-link{",
    ".cr-pane .tok-heading{",
    ".cr-pane .tok-invalid{",
    ".cr-pane .tok-deleted{",
    ".cr-pane .tok-inserted{",
  ]) {
    expect(css).toContain(selector);
  }
  expect(css).not.toContain(".cr-pane .tok-definition{");
  expect(css).not.toContain(".cr-pane .tok-local{");
  expect(css).not.toContain(".cr-pane .tok-function{");
});
