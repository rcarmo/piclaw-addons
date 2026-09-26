/** Layout only; Settings owns each skin's control appearance. */
export const resticStyles = `
@layer restic-fallback {
  .restic-settings .settings-addon-field { display:flex;flex-direction:column;align-items:stretch;gap:6px;min-width:0;margin:0 0 12px; }
  .restic-settings .settings-addon-label { font-size:13px;font-weight:500;color:var(--text-secondary); }
  .restic-settings .settings-addon-control { box-sizing:border-box;width:100%;min-width:0;max-width:100%;padding:6px 10px;border:1px solid var(--border-color);border-radius:6px;background:var(--bg-primary);color:var(--text-primary);font:inherit; }
  .restic-settings textarea.settings-addon-control { resize:vertical; }
  .restic-settings .settings-addon-actions { display:flex;align-items:center;flex-wrap:wrap;gap:8px; }
  .restic-settings button { box-sizing:border-box;min-height:32px;padding:6px 14px;border:1px solid var(--border-color);border-radius:6px;background:var(--bg-hover,var(--bg-secondary));color:var(--text-primary);font:inherit;cursor:pointer; }
  .restic-settings :is(button,input,select,textarea,summary):focus-visible { outline:2px solid var(--accent-color);outline-offset:2px; }
  .restic-settings :disabled { opacity:.5;cursor:not-allowed; }
}
.restic-settings { width:100%;max-width:920px;min-width:0;box-sizing:border-box;container-type:inline-size;font-size:13px;line-height:1.5;color:var(--text-primary); }
.restic-settings *, .restic-settings *::before, .restic-settings *::after { box-sizing:border-box; }
.restic-settings h4 { margin:0 0 8px;font-size:14px;font-weight:600;line-height:1.4;color:var(--text-primary); }
.restic-settings h5 { margin:0 0 6px;font-size:13px;font-weight:600;line-height:1.4;color:var(--text-primary); }
.restic-settings p { margin:6px 0 12px;overflow-wrap:anywhere; }
.restic-settings p:last-child { margin-bottom:0; }
.restic-settings code { font-family:var(--font-family-mono,var(--font-mono,monospace));font-size:12px;white-space:normal;overflow-wrap:anywhere;word-break:break-word; }
.restic-settings .restic-section { min-width:0;padding:16px 0;border-bottom:1px solid var(--border-color,var(--border)); }
.restic-settings .restic-section:first-of-type { padding-top:0; }
.restic-settings .restic-section:last-of-type { border-bottom:0;padding-bottom:0; }
.restic-settings .restic-compact-grid { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 12px;min-width:0; }
.restic-settings .restic-three-grid { display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px 12px;min-width:0; }
.restic-settings .restic-row { display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-width:0;margin:8px 0; }
.restic-settings .restic-actions { display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:10px 0; }
.restic-settings .restic-check { display:flex;align-items:flex-start;gap:8px;min-width:0;margin:8px 0;line-height:1.5; }
.restic-settings .restic-check > input[type=checkbox] { flex:0 0 auto;width:auto;min-height:0;margin:3px 0 0;accent-color:var(--accent-color,var(--accent)); }
.restic-settings .restic-help, .restic-settings .settings-addon-help, .restic-settings .restic-muted { color:var(--text-secondary);font-size:12px;line-height:1.5; }
.restic-settings .restic-warning { padding:10px 12px;border:1px solid color-mix(in srgb,var(--warning-color,#f59e0b) 45%,var(--border-color,var(--border)));border-radius:6px;background:color-mix(in srgb,var(--warning-color,#f59e0b) 10%,transparent);font-size:12px; }
.restic-settings .restic-card { min-width:0;padding:12px;border:1px solid var(--border-color,var(--border));border-radius:6px;background:var(--bg-primary);margin-top:10px; }
.restic-settings .restic-card-header { display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 8px;min-width:0;margin-bottom:8px; }
.restic-settings .restic-card-header strong { font-size:13px; }
.restic-settings .restic-pill { display:inline-flex;align-items:center;min-height:22px;padding:2px 8px;border-radius:999px;background:var(--bg-secondary);color:var(--text-secondary);font-size:12px; }
.restic-settings .restic-status-line { display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-width:0;margin:6px 0; }
.restic-settings .settings-addon-status { font-size:12px;color:var(--text-secondary);overflow-wrap:anywhere; }
.restic-settings .settings-addon-error { color:var(--danger-color,var(--error));overflow-wrap:anywhere; }
.restic-settings textarea, .restic-settings pre, .restic-settings .restic-mono { font-family:var(--font-family-mono,var(--font-mono,monospace)); }
.restic-settings pre.restic-json, .restic-settings pre.restic-log { white-space:pre-wrap;overflow:auto;max-height:260px;margin:8px 0 0;padding:10px;border-radius:6px;background:var(--bg-secondary);font-size:12px;line-height:1.45; }
.restic-settings .restic-log { max-height:180px; }
.restic-settings .restic-snapshot-list { display:grid;gap:8px;margin:8px 0 0; }
.restic-settings .restic-snapshot { min-width:0;padding:8px 10px;border:1px solid var(--border-color,var(--border));border-radius:6px;background:var(--bg-primary); }
.restic-settings .restic-snapshot strong { display:block;overflow-wrap:anywhere; }
.restic-settings .restic-danger { color:var(--danger-color,var(--error)); }
.restic-settings details { margin:10px 0;min-width:0; }
.restic-settings summary { cursor:pointer;color:var(--text-secondary);font-size:12px;width:fit-content;max-width:100%;overflow-wrap:anywhere; }
.restic-settings details[open] > summary { margin-bottom:10px; }
@container (max-width:640px) {
  .restic-settings .restic-compact-grid, .restic-settings .restic-three-grid { grid-template-columns:1fr; }
  .restic-settings .restic-card { padding:10px; }
  .restic-settings .restic-row { align-items:flex-start; }
}
`;
