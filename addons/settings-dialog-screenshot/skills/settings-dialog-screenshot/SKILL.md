---
name: settings-dialog-screenshot
description: Capture a screenshot of the Pi web settings dialog, cropped tightly to the dialog window only.
distribution: public
---

# Settings Dialog Screenshot

Use this skill when documenting Pi or piclaw add-ons and the user wants a screenshot of the **settings dialog only**.

## Goal

Produce a tightly cropped screenshot containing just the visible settings window/dialog.

## Preferred method

Use **DOM-targeted capture** instead of a full-page screenshot.

## Workflow

1. Open the relevant Pi web UI page.
2. Open the **Settings** dialog or pane to document.
3. Wait until the dialog is fully rendered.
4. Identify the top-level visible dialog container.
5. Capture a screenshot of **that element only**.
6. Save as PNG.
7. Attach the PNG if the user wants the image as a deliverable.

## Rules

- Do **not** capture the whole page if an element-level capture is possible.
- Do **not** include unrelated surrounding UI unless unavoidable.
- Prefer the outer visible dialog frame, including rounded corners and shadow.
- If the dialog is scrollable, capture the currently visible state unless the user explicitly asks for a stitched/full-content version.
- Never expose passwords, tokens, or private data in the screenshot.

## Good selectors

Prefer one of these, in order:

- the nearest stable modal root
- the element with `role="dialog"`
- the top-level settings pane container
- the visible card/window wrapper for the settings UI

If there are multiple nested matches, choose the **outermost visible settings dialog**.

## Playwright pattern

Preferred:

```ts
const dialog = page.locator('[role="dialog"]').first();
await dialog.screenshot({ path: 'settings-dialog.png' });
```

Fallback:

```ts
const dialog = page.locator('.settings-dialog, .modal, [role="dialog"]').first();
const box = await dialog.boundingBox();
await page.screenshot({
  path: 'settings-dialog.png',
  clip: box ?? undefined,
});
```

## Output expectations

- PNG preferred
- tight crop
- readable labels and toggles
- no unnecessary browser chrome
- safe to embed in a README or add-on docs page

## Use in documentation

When updating an add-on README:

- prefer a realistic populated example
- crop to the dialog only
- avoid clutter
- keep the screenshot current with the documented UI
