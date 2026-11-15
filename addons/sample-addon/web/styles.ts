// Standalone fallback for older supported hosts. Unlayered host contract wins.
export const settingsStyles = `
@layer sample-addon-settings-fallback {
  .sample-addon-settings { padding: .5rem 0; min-width: 0; }
  .sample-addon-settings .settings-addon-section { margin-bottom: 20px; min-width: 0; }
  .sample-addon-settings h4 { margin: 1.2rem 0 .4rem; font-size: .9rem; color: var(--text-primary); border-bottom: 1px solid var(--border-color); padding-bottom: .3rem; }
  .sample-addon-settings .settings-addon-field { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; min-width: 0; margin-bottom: 12px; }
  .sample-addon-settings .settings-addon-label { color: var(--text-secondary); font-size: .85rem; font-weight: 500; }
  .sample-addon-settings .settings-addon-control { box-sizing: border-box; min-width: 0; max-width: 100%; width: 280px; padding: 4px 8px; background: var(--bg-secondary); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; font-size: .85rem; }
  .sample-addon-settings .settings-addon-control-group, .sample-addon-settings .settings-addon-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; max-width: 100%; }
  .sample-addon-settings .settings-addon-control-group > .settings-addon-control { flex: 1 1 160px; }
  .sample-addon-settings .settings-addon-help { font-size: max(12px, .73rem); color: var(--text-secondary); line-height: 1.4; overflow-wrap: anywhere; }
  .sample-addon-settings .settings-addon-error { color: var(--danger-color); overflow-wrap: anywhere; }
  .sample-addon-settings .settings-addon-status { color: var(--text-secondary); overflow-wrap: anywhere; }
  .sample-addon-settings .settings-addon-badge { display: inline-block; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--border-color); color: var(--tone, var(--text-secondary)); font-size: max(12px, .82em); font-weight: 600; white-space: nowrap; }
  .sample-addon-settings .settings-addon-mono { font-family: var(--font-mono, ui-monospace, monospace); }
  .sample-addon-settings [data-tone="success"] { --tone: var(--success-color); }
  .sample-addon-settings [data-tone="danger"] { --tone: var(--danger-color); }
  .sample-addon-settings button { padding: 4px 10px; border: 1px solid var(--border-color); border-radius: 4px; background: var(--bg-secondary); color: var(--text-primary); cursor: pointer; font-size: .82rem; }
  .sample-addon-settings :is(button, input):focus-visible { outline: 2px solid var(--accent-color); outline-offset: 2px; }
  .sample-addon-settings :is(button, input):disabled { opacity: .5; }
  @media (max-width: 640px) {
    .sample-addon-settings .settings-addon-field { align-items: stretch; }
    .sample-addon-settings .settings-addon-control { width: 100%; }
  }
}
`;
