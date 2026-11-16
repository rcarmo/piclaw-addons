// Standalone fallback for older supported hosts. Host rules are unlayered.
export const settingsStyles = `
@layer delegate-settings-fallback {
  .delegate-settings { padding: .5rem 0; min-width: 0; }
  .delegate-settings .settings-addon-section { margin-bottom: 20px; min-width: 0; }
  .delegate-settings h4 { margin: 1.2rem 0 .45rem; font-size: .9rem; color: var(--text-primary); border-bottom: 1px solid var(--border-color); padding-bottom: .3rem; }
  .delegate-settings .settings-addon-field { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; min-width: 0; margin-bottom: 12px; }
  .delegate-settings .settings-addon-label { font-size: .84rem; font-weight: 500; color: var(--text-secondary); }
  .delegate-settings .settings-addon-control { box-sizing: border-box; width: 280px; min-width: 0; max-width: 100%; padding: 6px 10px; background: var(--bg-secondary); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 6px; font-size: .84rem; }
  .delegate-settings .settings-addon-help { font-size: .78rem; color: var(--text-secondary); line-height: 1.45; overflow-wrap: anywhere; }
  .delegate-settings .settings-addon-control-group, .delegate-settings .settings-addon-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; max-width: 100%; }
  .delegate-settings .settings-addon-control-group > .settings-addon-control { flex: 1 1 160px; }
  .delegate-settings .settings-addon-error { color: var(--danger-color); overflow-wrap: anywhere; }
  .delegate-settings .settings-addon-status { color: var(--text-secondary); overflow-wrap: anywhere; }
  .delegate-settings button { padding: 4px 10px; border: 1px solid var(--border-color); border-radius: 6px; background: var(--bg-secondary); color: var(--text-primary); cursor: pointer; font-size: .82rem; }
  .delegate-settings :is(button, input, textarea):focus-visible { outline: 2px solid var(--accent-color); outline-offset: 2px; }
  .delegate-settings :is(button, input, textarea):disabled { opacity: .5; }
  @media (max-width: 640px) {
    .delegate-settings .settings-addon-field { align-items: stretch; }
    .delegate-settings .settings-addon-control { width: 100%; }
  }
}
/* Pane-owned layout and list limits remain separate from host control styling. */
.delegate-settings .delegate-metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: .45rem; margin-bottom: .6rem; }
.delegate-settings .delegate-metric { padding: .55rem .65rem; border: 1px solid var(--border-color); border-radius: 7px; background: var(--bg-secondary); }
.delegate-settings .delegate-metric-count { font-size: 1.05rem; font-weight: 600; }
.delegate-settings .delegate-provider-row { display: flex; flex-wrap: wrap; align-items: center; gap: .65rem; margin: .45rem 0; min-width: 0; }
.delegate-settings .delegate-radio { display: inline-flex; align-items: center; gap: .25rem; }
.delegate-settings .delegate-provider-name { font-family: var(--font-mono, monospace); overflow-wrap: anywhere; }
.delegate-settings .delegate-scroll { overflow: auto; border: 1px solid var(--border-color); border-radius: 6px; overflow-wrap: anywhere; }
.delegate-settings .delegate-candidate { display: grid; grid-template-columns: 3rem minmax(0, 1fr); gap: .5rem; padding: .4rem .5rem; border-bottom: 1px solid var(--border-color); }
.delegate-settings .delegate-rejection { padding: .35rem .5rem; border-bottom: 1px solid var(--border-color); }
`;
