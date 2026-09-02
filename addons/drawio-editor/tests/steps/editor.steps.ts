import { expect } from '../../../../tests/addon-e2e/support/world';
import type { StepDefinition } from '../../../../tests/addon-e2e/support/gherkin-runner';
import type { Frame, Locator, Page } from '@playwright/test';

const INITIAL_LABEL = 'INITIAL-31.4.2';
const INITIAL_XML = `<mxfile host="app.diagrams.net"><diagram id="page-1" name="Page-1"><mxGraphModel dx="1260" dy="720" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="${INITIAL_LABEL}" style="rounded=0;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="120" y="100" width="180" height="80" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>`;

async function assertOk(response: any, label: string): Promise<void> {
  expect(response.ok(), `${label}: HTTP ${response.status()} ${await response.text().catch(() => '')}`).toBeTruthy();
}

async function putWorkspaceFile(page: Page, path: string, content: string): Promise<void> {
  const slash = path.lastIndexOf('/');
  const directory = slash >= 0 ? path.slice(0, slash) : '';
  const filename = slash >= 0 ? path.slice(slash + 1) : path;
  const response = await page.request.post(`/workspace/upload?path=${encodeURIComponent(directory)}&overwrite=1`, {
    multipart: { file: { name: filename, mimeType: 'application/vnd.jgraph.mxfile', buffer: Buffer.from(content) } },
  });
  await assertOk(response, `POST ${path}`);
}

async function workspaceBytes(page: Page, path: string): Promise<Buffer> {
  const response = await page.request.get(`/workspace/raw?path=${encodeURIComponent(path)}`);
  await assertOk(response, `GET ${path}`);
  return Buffer.from(await response.body());
}

async function waitForWorkspaceText(page: Page, path: string, text: string): Promise<void> {
  await expect.poll(async () => (await workspaceBytes(page, path)).toString('utf8'), { timeout: 15_000 }).toContain(text);
}

async function drawioFrame(page: Page, expectChrome = true): Promise<Frame> {
  const element = page.locator('#editor-frame');
  await expect(element).toBeVisible({ timeout: 20_000 });
  const handle = await element.elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error('Draw.io iframe did not acquire a content frame.');
  await frame.waitForFunction(() => Boolean((window as any).EditorUi?.VERSION && (window as any).mxClient?.VERSION), undefined, { timeout: 20_000 });
  if (expectChrome) await frame.waitForSelector('.geMenubarContainer', { timeout: 20_000 });
  return frame;
}

async function openEditor(page: Page, path: string): Promise<Frame> {
  await page.goto(`/drawio/edit.html?path=${encodeURIComponent(path)}`, { waitUntil: 'domcontentloaded' });
  return await drawioFrame(page);
}

async function visiblePopup(frame: Frame): Promise<Locator> {
  const popups = frame.locator('.mxPopupMenu:visible');
  await expect.poll(async () => popups.count(), { timeout: 5000 }).toBeGreaterThan(0);
  const popup = popups.nth((await popups.count()) - 1);
  await expect(popup).toBeVisible({ timeout: 5000 });
  await expect.poll(async () => popup.locator('tr').count(), { timeout: 5000 }).toBeGreaterThan(0);
  return popup;
}

async function openFileMenu(frame: Frame): Promise<Locator> {
  await frame.page().keyboard.press('Escape').catch(() => undefined);
  await expect.poll(async () => frame.locator('.mxPopupMenu:visible').count(), { timeout: 2000 }).toBe(0).catch(() => undefined);
  const file = frame.locator('.geMenubarContainer').getByText(/^File$/).first();
  await expect(file).toBeVisible({ timeout: 5000 });
  await file.click();
  return await visiblePopup(frame);
}

async function chooseSave(frame: Frame): Promise<void> {
  const filePopup = await openFileMenu(frame);
  await filePopup.getByText(/^Save$/).first().click();
}

async function openExportMenu(frame: Frame): Promise<void> {
  const filePopup = await openFileMenu(frame);
  const exportAs = filePopup.getByText(/^Export as(?:…|\.\.\.)?$/i).first();
  await expect(exportAs).toBeVisible({ timeout: 5000 });
  await exportAs.hover();
  await expect.poll(async () => frame.locator('.mxPopupMenu:visible').count(), { timeout: 5000 }).toBeGreaterThan(1);
}

async function exportFormat(page: Page, format: string): Promise<void> {
  const frame = await drawioFrame(page);
  await openExportMenu(frame);
  const popups = frame.locator('.mxPopupMenu:visible');
  const exportPopup = popups.last();
  const label = format === 'JPEG' ? /^(JPEG|JPG)(?:…|\.\.\.)?$/i : new RegExp(`^${format}(?:…|\\.\\.\\.)?$`, 'i');
  await exportPopup.getByText(label).first().click();
  const dialog = frame.locator('.geDialog:visible').last();
  await expect(dialog).toBeVisible({ timeout: 5000 });
  const editable = dialog.getByText(/include a copy of my diagram|editable/i).first();
  if (await editable.isVisible({ timeout: 500 }).catch(() => false)) {
    const checkbox = editable.locator('input[type="checkbox"]').first();
    if (await checkbox.count() && !(await checkbox.isChecked())) await checkbox.check();
  }
  await dialog.getByRole('button', { name: /^Export$/i }).click();
}

async function editRectangleLabel(page: Page, label: string): Promise<void> {
  const frame = await drawioFrame(page);
  const current = frame.getByText(INITIAL_LABEL, { exact: true }).first();
  await expect(current).toBeVisible({ timeout: 10_000 });
  await current.dblclick();
  const editor = frame.locator('[contenteditable="true"]:visible').last();
  await expect(editor).toBeVisible({ timeout: 5000 });
  await editor.fill(label);
  await editor.press('Control+Enter').catch(() => undefined);
  if (await editor.isVisible().catch(() => false)) await editor.press('Escape');
  await expect(frame.getByText(label, { exact: true }).first()).toBeVisible({ timeout: 5000 });
}

function menuLabels(text: string): string[] {
  return text.split(/\n+/).map((item) => item.replace(/\t.*$/, '').replace(/(?:Ctrl|Cmd|⌘)\s*\+?\s*S$/i, '').trim()).filter(Boolean);
}

export const steps: StepDefinition[] = [
  {
    pattern: /^a Draw\.io workspace file "([^"]+)" exists$/,
    async handler(ctx, path) {
      await putWorkspaceFile(ctx.page, path, INITIAL_XML);
      ctx.state.drawioPath = path;
    },
  },
  {
    pattern: /^I open the Draw\.io editor for "([^"]+)"$/,
    async handler(ctx, path) {
      ctx.state.drawioPath = path;
      await openEditor(ctx.page, path);
    },
  },
  {
    pattern: /^the embedded Draw\.io version is "([^"]+)"$/,
    async handler(ctx, version) {
      const frame = await drawioFrame(ctx.page);
      expect(await frame.evaluate(() => ({ editor: (window as any).EditorUi.VERSION, graph: (window as any).mxClient.VERSION })))
        .toEqual({ editor: version, graph: version });
    },
  },
  {
    pattern: /^the Draw\.io menus contain only Save, Export As, PNG, JPEG, and SVG$/,
    async handler(ctx) {
      const frame = await drawioFrame(ctx.page);
      const filePopup = await openFileMenu(frame);
      const fileLabels = menuLabels((await filePopup.locator('tr').allTextContents()).join('\n'));
      expect(fileLabels).toContain('Save');
      expect(fileLabels.some((label) => /^Export as/i.test(label))).toBe(true);
      expect(fileLabels.filter((label) => label !== 'Save' && !/^Export as/i.test(label)), `Unexpected File menu entries: ${fileLabels.join(', ')}`).toEqual([]);

      const exportAs = filePopup.getByText(/^Export as(?:…|\.\.\.)?$/i).first();
      await exportAs.hover();
      const popups = frame.locator('.mxPopupMenu:visible');
      await expect.poll(async () => popups.count(), { timeout: 5000 }).toBeGreaterThan(1);
      const exportPopup = popups.nth((await popups.count()) - 1);
      await expect.poll(async () => exportPopup.locator('tr').count(), { timeout: 5000 }).toBeGreaterThan(0);
      const exportLabels = menuLabels((await exportPopup.locator('tr').allTextContents()).join('\n'));
      expect(exportLabels.some((label) => /^PNG/i.test(label))).toBe(true);
      expect(exportLabels.some((label) => /^(JPEG|JPG)/i.test(label))).toBe(true);
      expect(exportLabels.some((label) => /^SVG/i.test(label))).toBe(true);
      const supported = exportLabels.filter((label) => /^(PNG|JPEG|JPG|SVG)(?:…|\.\.\.)?$/i.test(label));
      expect(supported).toHaveLength(3);
      expect(exportLabels.filter((label) => !/^(PNG|JPEG|JPG|SVG)(?:…|\.\.\.)?$/i.test(label)), `Unexpected Export As entries: ${exportLabels.join(', ')}`).toEqual([]);
    },
  },
  {
    pattern: /^I edit the rectangle label to "([^"]+)"$/,
    async handler(ctx, label) {
      await editRectangleLabel(ctx.page, label);
      ctx.state.drawioLabel = label;
    },
  },
  {
    pattern: /^"([^"]+)" contains "([^"]+)"$/,
    async handler(ctx, path, text) {
      await waitForWorkspaceText(ctx.page, path, text);
    },
  },
  {
    pattern: /^I reload the Draw\.io editor$/,
    async handler(ctx) {
      await ctx.page.reload({ waitUntil: 'domcontentloaded' });
      await drawioFrame(ctx.page);
    },
  },
  {
    pattern: /^the diagram contains a cell labelled "([^"]+)"$/,
    async handler(ctx, label) {
      const frame = await drawioFrame(ctx.page);
      await expect(frame.getByText(label, { exact: true }).first()).toBeVisible({ timeout: 10_000 });
    },
  },
  {
    pattern: /^I choose Save from the Draw\.io File menu$/,
    async handler(ctx) {
      await chooseSave(await drawioFrame(ctx.page));
    },
  },
  {
    pattern: /^the Draw\.io editor reports "([^"]+)"$/,
    async handler(ctx, text) {
      const frame = await drawioFrame(ctx.page);
      await expect(frame.getByText(new RegExp(text, 'i')).first()).toBeVisible({ timeout: 10_000 });
    },
  },
  {
    pattern: /^I export the diagram as "(PNG|JPEG|SVG)"$/,
    async handler(ctx, format) {
      await exportFormat(ctx.page, format);
      const source = String(ctx.state.drawioPath || '');
      const extension = format === 'JPEG' ? '.jpg' : `.${format.toLowerCase()}`;
      const path = source.replace(/\.drawio(?:\.(?:xml|svg|png))?$/i, extension);
      ctx.state[`drawioExport${format}`] = path;
      await expect.poll(async () => (await ctx.page.request.get(`/workspace/raw?path=${encodeURIComponent(path)}`)).status(), { timeout: 15_000 }).toBe(200);
    },
  },
  {
    pattern: /^the workspace file "([^"]+)" has a PNG signature$/,
    async handler(ctx, path) {
      expect((await workspaceBytes(ctx.page, path)).subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    },
  },
  {
    pattern: /^the workspace file "([^"]+)" has a JPEG signature$/,
    async handler(ctx, path) {
      expect((await workspaceBytes(ctx.page, path)).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    },
  },
  {
    pattern: /^the workspace file "([^"]+)" contains "([^"]+)"$/,
    async handler(ctx, path, text) {
      expect((await workspaceBytes(ctx.page, path)).toString('utf8')).toContain(text);
    },
  },
  {
    pattern: /^reopening "([^"]+)" shows "([^"]+)"$/,
    async handler(ctx, path, label) {
      await openEditor(ctx.page, path);
      await expect((await drawioFrame(ctx.page)).getByText(label, { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    },
  },
  {
    pattern: /^a Draw\.io media attachment named "([^"]+)" exists$/,
    async handler(ctx, filename) {
      const form = new FormData();
      form.append('file', new File([INITIAL_XML], filename, { type: 'application/vnd.jgraph.mxfile' }));
      const response = await ctx.page.request.post('/media/upload', { multipart: { file: { name: filename, mimeType: 'application/vnd.jgraph.mxfile', buffer: Buffer.from(INITIAL_XML) } } });
      await assertOk(response, 'POST /media/upload');
      const payload = await response.json();
      ctx.state.drawioMediaId = payload.id;
      ctx.state.drawioMediaName = filename;
      void form;
    },
  },
  {
    pattern: /^I open its Draw\.io attachment preview$/,
    async handler(ctx) {
      const id = Number(ctx.state.drawioMediaId);
      const name = String(ctx.state.drawioMediaName || 'preview.drawio');
      await ctx.page.goto(`/drawio/edit.html?media=${id}&name=${encodeURIComponent(name)}&readonly=1#media=${id}&name=${encodeURIComponent(name)}&readonly=1`, { waitUntil: 'domcontentloaded' });
      await drawioFrame(ctx.page, false);
    },
  },
  {
    pattern: /^the Draw\.io attachment editor is read-only$/,
    async handler(ctx) {
      const frameElement = ctx.page.locator('#editor-frame');
      await expect(frameElement).toHaveAttribute('src', /edit=0/);
      const frame = await drawioFrame(ctx.page, false);
      expect(await frame.evaluate(() => new URL(location.href).searchParams.get('edit'))).toBe('0');
    },
  },
  {
    pattern: /^the read-only overlay blocks editing$/,
    async handler(ctx) {
      const overlay = ctx.page.locator('#readonly-lock');
      await expect(overlay).toHaveClass(/active/);
      await expect(overlay).toHaveCSS('display', 'block');
      await expect(overlay).toHaveCSS('cursor', 'not-allowed');
    },
  },
];
