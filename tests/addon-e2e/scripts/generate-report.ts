#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

const e2eRoot = resolve(import.meta.dir, '..');
const repoRoot = resolve(e2eRoot, '../..');
const resultsPath = join(e2eRoot, 'reports', 'results.json');
const testResultsDir = join(e2eRoot, 'test-results');

if (!existsSync(resultsPath)) {
  console.error(`Error: ${relative(repoRoot, resultsPath)} not found. Run add-on E2E tests first.`);
  process.exit(1);
}

const results = JSON.parse(readFileSync(resultsPath, 'utf8'));

interface TestResult {
  addon: string;
  suite: string;
  title: string;
  status: string;
  duration: number;
  error: string;
  attachments: Array<{ contentType?: string; path?: string; name?: string }>;
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function dur(ms: number): string { return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`; }
function emoji(status: string): string { return status === 'passed' ? '✅' : status === 'failed' ? '❌' : status === 'timedOut' ? '⏱️' : status === 'skipped' ? '⏭️' : '❓'; }
function b64(path: string): string { try { return `data:image/png;base64,${readFileSync(path).toString('base64')}`; } catch { return ''; } }
function addonFromFile(file = ''): string {
  const normalized = file.replaceAll('\\', '/');
  const match = normalized.match(/\.generated\/([^/]+)\//);
  return match?.[1] || process.env.PICLAW_ADDON || 'addon';
}

function findImages(dir: string): string[] {
  const images: string[] = [];
  if (!existsSync(dir)) return images;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) images.push(...findImages(full));
    else if (entry.name.endsWith('.png')) images.push(full);
  }
  return images;
}

const allTests: TestResult[] = [];
function collect(suite: any, prefix = '', inheritedFile = '') {
  const suiteTitle = suite.title ? (prefix ? `${prefix} › ${suite.title}` : suite.title) : prefix;
  const suiteFile = suite.file || inheritedFile;
  for (const spec of suite.specs || []) {
    for (const test of spec.tests || []) {
      for (const result of test.results || []) {
        const file = spec.file || suiteFile;
        allTests.push({
          addon: addonFromFile(file),
          suite: suiteTitle || addonFromFile(file),
          title: spec.title,
          status: result.status,
          duration: result.duration || 0,
          error: result.error?.message || result.errors?.map((e: any) => e.message).join('\n') || '',
          attachments: result.attachments || [],
        });
      }
    }
  }
  for (const child of suite.suites || []) collect(child, suiteTitle, suiteFile);
}
for (const suite of results.suites || []) collect(suite);

function renderHtml(addon: string, tests: TestResult[]): string {
  const passed = tests.filter((t) => t.status === 'passed').length;
  const failed = tests.filter((t) => t.status === 'failed' || t.status === 'timedOut').length;
  const skipped = tests.filter((t) => t.status === 'skipped').length;
  const totalDur = tests.reduce((sum, t) => sum + t.duration, 0);
  const bySuite: Record<string, TestResult[]> = {};
  for (const test of tests) (bySuite[test.suite] ??= []).push(test);

  let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','IBM Plex Sans',sans-serif;margin:40px;color:#102033;font-size:11px;line-height:1.45}
h1{font-size:22px;margin:0 0 4px}.meta{color:#64748b;font-size:10px;margin-bottom:12px}.summary{margin:12px 0;padding:10px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:7px;font-size:13px}.summary span{margin-right:16px;font-weight:600}.pass{color:#16a34a}.fail{color:#dc2626}.skip{color:#64748b}
h2{font-size:14px;margin-top:22px;border-bottom:1px solid #e2e8f0;padding-bottom:4px}table{width:100%;border-collapse:collapse;margin:8px 0;font-size:10.5px}th,td{text-align:left;padding:4px 8px;border-bottom:1px solid #f1f5f9}th{background:#f8fafc;color:#475569;text-transform:uppercase;font-size:10px}tr.failed{background:#fef2f2}.error{color:#dc2626;white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:10px}.screenshot{max-width:100%;max-height:220px;margin:8px 0;border:1px solid #e2e8f0;border-radius:4px}.badge{display:inline-block;padding:1px 6px;border-radius:3px;font-size:9px;font-weight:700}.badge-pass{background:#dcfce7;color:#166534}.badge-fail{background:#fee2e2;color:#991b1b}.page-break{page-break-before:always}
</style></head><body>
<h1>${esc(addon)} Add-on UX Test Report</h1>
<p class="meta">Generated: ${new Date().toISOString()} · Playwright · ${esc(results.config?.projects?.map((p: any) => p.name).join(', ') || 'default')}</p>
<div class="summary"><span class="pass">✅ ${passed} passed</span><span class="fail">${failed ? '❌' : ''} ${failed} failed</span><span class="skip">⏭️ ${skipped} skipped</span><span>${tests.length} total · ${dur(totalDur)}</span></div>`;

  let suiteIndex = 0;
  for (const [suite, suiteTests] of Object.entries(bySuite)) {
    const sf = suiteTests.filter((t) => t.status === 'failed' || t.status === 'timedOut').length;
    const sp = suiteTests.filter((t) => t.status === 'passed').length;
    if (suiteIndex > 0 && suiteIndex % 4 === 0) html += '<div class="page-break"></div>';
    html += `<h2>${esc(suite)} ${sf ? `<span class="badge badge-fail">${sf} FAIL</span>` : '<span class="badge badge-pass">PASS</span>'} (${sp}/${suiteTests.length})</h2>`;
    html += '<table><tr><th></th><th>Scenario</th><th>Duration</th></tr>';
    for (const t of suiteTests) {
      const failedRow = t.status === 'failed' || t.status === 'timedOut';
      html += `<tr${failedRow ? ' class="failed"' : ''}><td>${emoji(t.status)}</td><td>${esc(t.title)}`;
      if (t.error) html += `<br><span class="error">${esc(t.error.slice(0, 600))}</span>`;
      html += `</td><td>${dur(t.duration)}</td></tr>`;
      for (const att of t.attachments.filter((a) => a.contentType === 'image/png' && a.path)) {
        const src = b64(att.path!);
        if (src) html += `<tr><td></td><td colspan="2"><img class="screenshot" src="${src}"></td></tr>`;
      }
    }
    html += '</table>';
    suiteIndex++;
  }

  const screenshots = findImages(testResultsDir).filter((path) => path.includes(addon));
  if (screenshots.length) {
    html += '<div class="page-break"></div><h2>Screenshots</h2>';
    for (const img of screenshots.slice(0, 30)) {
      const src = b64(img);
      if (src) html += `<p><strong>${esc(basename(img))}</strong></p><img class="screenshot" src="${src}">`;
    }
  }
  return `${html}</body></html>`;
}

async function renderPdf(html: string, outputPath: string): Promise<void> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  await page.pdf({ path: outputPath, format: 'A4', margin: { top: '16mm', bottom: '16mm', left: '12mm', right: '12mm' }, printBackground: true });
  await browser.close();
}

const byAddon: Record<string, TestResult[]> = {};
for (const test of allTests) (byAddon[test.addon] ??= []).push(test);

for (const [addon, tests] of Object.entries(byAddon)) {
  const addonReportDir = join(repoRoot, 'addons', addon, 'tests', 'reports');
  const e2eReportDir = join(e2eRoot, 'reports', addon);
  mkdirSync(addonReportDir, { recursive: true });
  mkdirSync(e2eReportDir, { recursive: true });
  const html = renderHtml(addon, tests);
  const htmlPath = join(addonReportDir, `${addon}-ux-report.html`);
  const pdfPath = join(addonReportDir, `${addon}-ux-report.pdf`);
  writeFileSync(htmlPath, html);
  writeFileSync(join(addonReportDir, 'results.json'), JSON.stringify({ addon, tests }, null, 2));
  try {
    await renderPdf(html, pdfPath);
    console.log(`PDF report: ${relative(repoRoot, pdfPath)}`);
  } catch (err) {
    console.log(`PDF rendering skipped for ${addon}: ${(err as Error).message}`);
  }
  copyFileSync(htmlPath, join(e2eReportDir, basename(htmlPath)));
  if (existsSync(pdfPath)) copyFileSync(pdfPath, join(e2eReportDir, basename(pdfPath)));
}

console.log(`Generated add-on UX reports for ${Object.keys(byAddon).length} add-on(s).`);
