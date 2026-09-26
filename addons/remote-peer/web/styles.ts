/** Layout only; Settings owns each skin's control appearance. */
export const remotePeerStyles = `
@layer remote-peer-fallback {
  .remote-peer-settings .settings-addon-field { display:flex;flex-direction:column;align-items:stretch;gap:6px;min-width:0;margin:0 0 12px; }
  .remote-peer-settings .settings-addon-label { font-size:13px;font-weight:500;color:var(--text-secondary); }
  .remote-peer-settings .settings-addon-control { box-sizing:border-box;width:100%;min-width:0;max-width:100%;padding:6px 10px;border:1px solid var(--border-color);border-radius:6px;background:var(--bg-primary);color:var(--text-primary);font:inherit; }
  .remote-peer-settings textarea.settings-addon-control { resize:vertical; }
  .remote-peer-settings .settings-addon-actions { display:flex;align-items:center;flex-wrap:wrap;gap:8px; }
  .remote-peer-settings button { box-sizing:border-box;min-height:32px;padding:6px 14px;border:1px solid var(--border-color);border-radius:6px;background:var(--bg-hover,var(--bg-secondary));color:var(--text-primary);font:inherit;cursor:pointer; }
  .remote-peer-settings :is(button,input,select,textarea,summary):focus-visible { outline:2px solid var(--accent-color);outline-offset:2px; }
  .remote-peer-settings :disabled { opacity:.5;cursor:not-allowed; }
}
.remote-peer-settings { width:100%;max-width:900px;min-width:0;box-sizing:border-box;container-type:inline-size;font-size:13px;line-height:1.5;color:var(--text-primary); }
.remote-peer-settings *, .remote-peer-settings *::before, .remote-peer-settings *::after { box-sizing:border-box; }
.remote-peer-settings h4 { margin:0 0 8px;font-size:14px;font-weight:600;line-height:1.4;color:var(--text-primary); }
.remote-peer-settings h5 { margin:0 0 6px;font-size:13px;font-weight:600;line-height:1.4;color:var(--text-primary); }
.remote-peer-settings p { margin:6px 0 12px;overflow-wrap:anywhere; }
.remote-peer-settings p:last-child { margin-bottom:0; }
.remote-peer-settings .remote-peer-section { min-width:0;padding:16px 0;border-bottom:1px solid var(--border-color,var(--border)); }
.remote-peer-settings .remote-peer-section:first-of-type { padding-top:0; }
.remote-peer-settings .remote-peer-section:last-of-type { border-bottom:0;padding-bottom:0; }
.remote-peer-settings .remote-peer-row { display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-width:0;margin:8px 0; }
.remote-peer-settings .remote-peer-actions { display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-width:0; }
.remote-peer-settings .remote-peer-actions button, .remote-peer-settings .remote-peer-row button { flex:0 1 auto;max-width:100%;overflow-wrap:anywhere; }
.remote-peer-settings .remote-peer-card { min-width:0;padding:12px;border:1px solid var(--border-color,var(--border));border-radius:6px;background:var(--bg-primary);margin-top:12px; }
.remote-peer-settings .remote-peer-card-header { display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 8px;margin-bottom:8px;min-width:0;overflow-wrap:anywhere; }
.remote-peer-settings .remote-peer-card-header strong { font-size:13px; }
.remote-peer-settings .remote-peer-name { color:var(--text-secondary);overflow-wrap:anywhere; }
.remote-peer-settings .remote-peer-state { font-size:12px;color:var(--text-secondary);margin-left:auto; }
.remote-peer-settings code { font-family:var(--font-family-mono,var(--font-mono,monospace));font-size:12px;white-space:normal;overflow-wrap:anywhere;word-break:break-word;min-width:0; }
.remote-peer-settings .remote-peer-id { display:block;padding:8px 10px;border-radius:4px;background:var(--bg-secondary); }
.remote-peer-settings .remote-peer-identity { display:flex;flex-direction:column;align-items:stretch;gap:8px;margin:6px 0 8px; }
.remote-peer-settings .remote-peer-row > code { flex:1 1 220px; }
.remote-peer-settings .remote-peer-row > span { min-width:0;overflow-wrap:anywhere; }
.remote-peer-settings .remote-peer-check { display:flex;align-items:flex-start;gap:8px;min-width:0;margin:8px 0;line-height:1.5; }
.remote-peer-settings .remote-peer-check > input[type=checkbox], .remote-peer-settings .remote-peer-checks input[type=checkbox] { flex:0 0 auto;width:auto;min-height:0;margin:3px 0 0;accent-color:var(--accent-color,var(--accent)); }
.remote-peer-settings .remote-peer-checks { display:flex;flex-wrap:wrap;gap:8px 16px; }
.remote-peer-settings .remote-peer-checks label { display:inline-flex;align-items:flex-start;gap:6px;min-width:0;overflow-wrap:anywhere; }
.remote-peer-settings .remote-peer-description, .remote-peer-settings .settings-addon-help { color:var(--text-secondary);font-size:12px;line-height:1.5; }
.remote-peer-settings .settings-addon-field { margin-top:0; }
.remote-peer-settings .settings-addon-field > .settings-addon-control { width:100%; }
.remote-peer-settings details { margin:12px 0;min-width:0; }
.remote-peer-settings summary { cursor:pointer;color:var(--text-secondary);font-size:12px;width:fit-content;max-width:100%;overflow-wrap:anywhere; }
.remote-peer-settings details[open] > summary { margin-bottom:10px; }
.remote-peer-settings textarea { font-family:var(--font-family-mono,var(--font-mono,monospace)); }
.remote-peer-settings .remote-peer-permissions { min-width:0;margin-top:12px;padding-top:12px;border-top:1px solid var(--border-color,var(--border)); }
.remote-peer-settings .remote-peer-permissions section { margin:0 0 16px;min-width:0; }
.remote-peer-settings .remote-peer-permissions section:last-child { margin-bottom:0; }
.remote-peer-settings .remote-peer-permissions fieldset { min-width:0;margin:12px 0;padding:10px;border:1px solid var(--border-color,var(--border));border-radius:6px; }
.remote-peer-settings .remote-peer-permissions legend { padding:0 4px;font-size:12px;color:var(--text-secondary);max-width:100%;overflow-wrap:anywhere; }
.remote-peer-settings .remote-peer-saved { overflow-wrap:anywhere;font-size:12px; }
.remote-peer-settings .settings-addon-status { font-size:12px;color:var(--text-secondary);overflow-wrap:anywhere; }
.remote-peer-settings .settings-addon-error { color:var(--danger-color,var(--error));overflow-wrap:anywhere; }
.remote-peer-settings .remote-peer-work-prompt { white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 var(--font-family-mono,var(--font-mono,monospace));max-height:240px;overflow:auto;margin:10px 0; }
@container (max-width:440px) {
  .remote-peer-settings .remote-peer-card { padding:10px; }
  .remote-peer-settings .remote-peer-row { align-items:flex-start; }
  .remote-peer-settings .remote-peer-row > code { flex-basis:100%; }
  .remote-peer-settings .remote-peer-state { margin-left:0; }
}
`;
