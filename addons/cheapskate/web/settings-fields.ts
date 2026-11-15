/** Package-local fallback for supported hosts predating the shared field contract.
 * Layered, pane-scoped rules yield to the host; native booleans/buttons are untouched.
 */
export const settingsFieldStyles = `
@layer cheapskate-settings-fields {
  :where([data-settings-addon="cheapskate"]) .settings-addon-field { display:flex;flex-direction:column;align-items:flex-start;gap:6px;min-width:0;max-width:100%;margin-bottom:12px; }
  :where([data-settings-addon="cheapskate"]) .settings-addon-label { color:var(--text-secondary);font-size:.88em;font-weight:500; }
  :where([data-settings-addon="cheapskate"]) .settings-addon-control { box-sizing:border-box;min-width:0;max-width:100%;width:280px;padding:6px 10px;border:1px solid var(--border-color);border-radius:6px;background:var(--bg-primary);color:var(--text-primary);font-size:.88em; }
  :where([data-settings-addon="cheapskate"]) textarea.settings-addon-control { resize:vertical; }
  :where([data-settings-addon="cheapskate"]) .settings-addon-control-group { display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-width:0;max-width:100%; }
  :where([data-settings-addon="cheapskate"]) .settings-addon-control-group > .settings-addon-control { flex:1 1 160px; }
  :where([data-settings-addon="cheapskate"]) .settings-addon-help { color:var(--text-secondary);font-size:max(12px,.84em);overflow-wrap:anywhere; }
  :where([data-settings-addon="cheapskate"]) .settings-addon-control:focus-visible { outline:2px solid var(--accent-color);outline-offset:2px; }
  :where([data-settings-addon="cheapskate"]) .settings-addon-control:disabled { opacity:.5; }
  :where([data-settings-addon="cheapskate"]) .settings-addon-heading { margin:24px 0 10px;font-size:1.1em;font-weight:600;color:var(--text-primary); }
  :where([data-settings-addon="cheapskate"]) .settings-addon-heading:first-of-type { margin-top:0; }
  :where([data-settings-addon="cheapskate"]) p.settings-addon-help { margin:0 0 12px; }
  :where([data-settings-addon="cheapskate"]) .settings-addon-check { display:flex;width:fit-content;max-width:100%;align-items:center;flex-wrap:wrap;gap:8px;min-width:0;margin-bottom:12px;color:var(--text-primary);font-size:.88em;cursor:pointer; }
  :where([data-settings-addon="cheapskate"]) .settings-addon-badge { display:inline-block;padding:1px 7px;border-radius:999px;border:1px solid var(--border-color);color:var(--tone,var(--text-secondary));font-size:max(12px,.82em);font-weight:600;white-space:nowrap; }
  :where([data-settings-addon="cheapskate"]) .settings-addon-callout { margin:0 0 12px;padding:8px 12px;border:1px solid var(--border-color);border-left:3px solid var(--tone,var(--border-color));border-radius:6px;color:var(--text-primary); }
  :where([data-settings-addon="cheapskate"]) [data-tone="success"] { --tone:var(--success-color); }
  :where([data-settings-addon="cheapskate"]) [data-tone="danger"] { --tone:var(--danger-color); }
  :where([data-settings-addon="cheapskate"]) [data-tone="warning"] { --tone:var(--warning-color); }
  :where([data-settings-addon="cheapskate"]) [data-tone="info"] { --tone:var(--accent-color); }
  :where([data-settings-addon="cheapskate"]) .settings-addon-actions { display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0;margin:0 0 12px; }
  :where([data-settings-addon="cheapskate"]) .settings-addon-status { color:var(--text-secondary);overflow-wrap:anywhere; }
  :where([data-settings-addon="cheapskate"]) .settings-addon-error { color:var(--danger-color);overflow-wrap:anywhere; }
  :where([data-settings-addon="cheapskate"]) .settings-addon-mono { font-family:var(--font-mono,ui-monospace,monospace); }
  @media(max-width:640px) {
    :where([data-settings-addon="cheapskate"]) .settings-addon-field { align-items:stretch; }
    :where([data-settings-addon="cheapskate"]) .settings-addon-control { width:100%; }
  }
}
/* Pane-owned layout (not a host fallback), so it is unlayered. */
[data-settings-addon="cheapskate"] .cheapskate-candidate { margin:8px 0;padding:10px 12px;border:1px solid var(--border-color);border-radius:8px;background:var(--bg-secondary);min-width:0; }
[data-settings-addon="cheapskate"] .cheapskate-candidate-head { display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0; }
[data-settings-addon="cheapskate"] .cheapskate-candidate-head > code { overflow-wrap:anywhere; }
[data-settings-addon="cheapskate"] .cheapskate-state { margin-left:auto; }
[data-settings-addon="cheapskate"] .cheapskate-facts { display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:6px; }
[data-settings-addon="cheapskate"] .cheapskate-filters { align-items:flex-start;margin-bottom:8px; }
`;
