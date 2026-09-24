export const styles = `
.cr-pane{
  --green:var(--success-color);
  --green-bg:color-mix(in srgb,#2da44e 14%,var(--bg-code,var(--bg-primary)));
  --red:var(--danger-color);
  --red-bg:color-mix(in srgb,#cf222e 12%,var(--bg-code,var(--bg-primary)));
  --cr-add:var(--green-bg);
  --cr-del:var(--red-bg);
  display:flex;
  flex-direction:column;
  height:100%;
  min-width:0;
  position:relative;
  color:var(--text-primary);
  background:var(--bg-primary);
  font:13px/1.5 var(--font-family,system-ui,sans-serif);
  container-type:inline-size;
}
.cr-pane *{box-sizing:border-box}
.cr-pane [hidden]{display:none!important}
.cr-pane button,.cr-pane input,.cr-pane select,.cr-pane textarea{font:inherit;color:inherit}
.cr-pane button{cursor:pointer}
.cr-pane button:disabled{cursor:not-allowed;opacity:.55}
.cr-pane input,.cr-pane select,.cr-pane textarea{border:1px solid var(--border-color);border-radius:6px;background:var(--bg-primary);padding:5px 8px;min-width:0}
.cr-pane select{max-width:190px}
.cr-pane :focus-visible{outline:2px solid var(--accent-color);outline-offset:2px}
.cr-pane input[type=checkbox]{accent-color:var(--accent-color)}
.cr-pane label{display:inline-flex;align-items:center;gap:5px}
.cr-pane small,.cr-muted{font-size:11px;color:var(--text-secondary)}
.cr-grow{flex:1;min-width:0}
.cr-empty{padding:20px;color:var(--text-secondary)}
.cr-toolbar{display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid var(--border-color);flex-wrap:wrap;flex:none}
.cr-toolbar select{font-size:12px}
.cr-options{position:relative}
.cr-menu{position:absolute;z-index:8;right:0;top:100%;width:210px;padding:7px;display:grid;gap:5px;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:6px;box-shadow:0 4px 18px #0002}
.cr-menu button{text-align:left}
.cr-status{display:flex;justify-content:space-between;align-items:center;gap:8px;white-space:pre-wrap;padding:6px 10px;font-size:12px;border-bottom:1px solid var(--border-color)}
.cr-receipts{padding:10px;border-bottom:1px solid var(--border-color);max-height:35%;overflow:auto}
.cr-receipts header,.cr-receipts article{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:5px}
.cr-receipts header{justify-content:space-between}
.cr-receipts article+article{border-top:1px solid var(--border-color)}
.cr-body{display:flex;flex:1;min-height:0;min-width:0}
.cr-files{width:210px;flex:none;border-right:1px solid var(--border-color);overflow:auto;padding:8px;background:var(--bg-secondary)}
.cr-files header{display:flex;align-items:center;justify-content:space-between;margin-bottom:7px}
.cr-files input{width:100%;margin-bottom:7px}
.cr-files .cr-unresolved-filter{font-size:11px;margin-bottom:7px}
.cr-files .cr-unresolved-filter input{width:auto;margin:0}
.cr-file-stats{display:flex;gap:7px;align-items:center;width:100%}
.cr-file-stats small{flex:1}
.cr-file-add{color:var(--green)}
.cr-file-del{color:var(--red)}
.cr-thread-path,.cr-thread-summary{width:100%;overflow-wrap:anywhere;margin:0}
.cr-thread-summary{white-space:pre-wrap;font-size:12px}
.cr-summary-author{margin-bottom:7px;display:flex;gap:8px;align-items:center;color:var(--text-primary)}
.cr-delivery{padding:1px 6px;border:1px solid var(--border-color);border-radius:4px;white-space:nowrap;flex:none}
.cr-evidence{padding:8px;border:1px solid var(--border-color);margin-top:8px;overflow-wrap:anywhere}
.cr-evidence small{display:block}
.cr-evidence ul{margin:4px 0;padding-left:18px}
.cr-file-header #cr-snapshot{font-size:11px;max-width:180px}
.cr-file-kind{padding:2px 6px;border:1px solid var(--border-color);border-radius:4px;text-transform:capitalize}
.cr-drawer-intro{font-size:12px;color:var(--text-secondary);margin:10px 0 18px}
.cr-pane .cr-drawer-item{border:1px solid var(--border-color);border-radius:6px;padding:12px;margin:10px 0}
.cr-queue-help{background:var(--accent-soft,var(--bg-secondary));padding:12px;border-radius:6px}
.cr-queue-help strong{display:block;color:var(--text-primary);margin-bottom:5px}
.cr-summary-label{margin-top:12px}
.cr-preview-details{margin-top:12px;font-size:11px;color:var(--text-secondary)}
.cr-preview-details summary{cursor:pointer}
.cr-files>button{display:flex;flex-direction:column;align-items:flex-start;width:100%;text-align:left;overflow-wrap:anywhere;padding:8px;border:0;background:none}
.cr-files>button.active{background:var(--accent-soft,color-mix(in srgb,var(--accent-color) 12%,transparent))}
.cr-main{display:flex;flex:1;flex-direction:column;min-width:0;min-height:0;overflow:hidden}
.cr-file-header{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:5px 10px;border-bottom:1px solid var(--border-color);flex:none}
.cr-file-header strong{font:12px var(--font-family-mono,monospace);overflow-wrap:anywhere}
.cr-current-source{font-size:11px;color:var(--warning-color,var(--text-secondary));overflow-wrap:anywhere}
.cr-source{flex:1;min-height:80px;overflow:auto;background:var(--bg-code,var(--bg-primary));color:var(--text-code,var(--text-primary))}
.cr-line{display:grid;grid-template-columns:24px 42px 18px minmax(0,1fr);min-width:max-content;font:12px/18px var(--font-family-mono,monospace);padding:0;min-height:18px}
.cr-line>button{font:11px/18px var(--font-family-mono,monospace);height:18px;min-height:0;border:0;padding:0 3px;background:transparent;color:var(--text-secondary);border-radius:0}
.cr-line>button:first-child{color:var(--accent-color)}
.cr-line code{white-space:pre;display:block;padding:0 8px 0 0;font:inherit}
.cr-line>span{text-align:center}
.cr-line.cr-diff-line{grid-template-columns:24px 42px 42px 18px minmax(0,1fr)}
.cr-line .cr-old-line{font:11px/18px var(--font-family-mono,monospace);color:var(--text-secondary);text-align:right;padding-right:3px}
.cr-expand{display:block;width:100%;text-align:left;padding:4px 10px;border:0;border-block:1px solid var(--border-color);color:var(--text-secondary);background:var(--bg-secondary);font-size:11px}
.cr-line.added{background:var(--cr-add)}
.cr-line.deleted{background:var(--cr-del)}
.cr-line.selected{box-shadow:inset 3px 0 var(--accent-color)}
.cr-line.context.selected{background:var(--accent-soft)}
.cr-pair{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--border-color)}
.cr-pair>.cr-line{min-width:0;overflow-x:auto}
.cr-pair>.cr-line.context,.cr-blank{background:var(--bg-code,var(--bg-primary))}
.cr-source.wrap .cr-line{min-width:0}
.cr-source.wrap code{white-space:pre-wrap;overflow-wrap:anywhere}
.cr-pagination,.cr-selection{display:flex;align-items:center;gap:8px;padding:5px 10px;border-top:1px solid var(--border-color);font-size:11px;flex-wrap:wrap}
.cr-thread{margin:10px;border:1px solid var(--border-color);border-radius:6px;background:var(--bg-primary);color:var(--text-primary);font:13px/1.5 var(--font-family,system-ui,sans-serif)}
.cr-thread header{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:7px 10px;background:var(--bg-secondary)}
.cr-thread header strong{font-size:12px}
.cr-thread header span{flex:1}
.cr-thread footer,.cr-composer footer{display:flex;gap:6px;padding:7px 10px;flex-wrap:wrap;align-items:center;border-top:1px solid var(--border-color)}
.cr-message{padding:10px;border-top:1px solid var(--border-color)}
.cr-message p{white-space:pre-wrap;overflow-wrap:anywhere;margin:7px 0}
.cr-composer{padding:8px 10px;flex:none;border-top:1px solid var(--accent-color);max-height:45%;overflow:auto}
.cr-composer>strong{font-size:12px}
.cr-composer textarea{width:100%;resize:vertical;min-height:80px;display:block;margin-top:5px}
.cr-composer footer{padding:7px 0 0;border:0}
.cr-backdrop{position:absolute;inset:0;background:#0005;z-index:9}
.cr-drawer{position:absolute;right:0;top:0;bottom:0;width:400px;max-width:100%;z-index:10;background:var(--bg-primary);border-left:1px solid var(--border-color);box-shadow:-8px 0 30px #0002;overflow:auto;padding:16px}
.cr-drawer>header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.cr-drawer-item{display:flex;flex-wrap:wrap;align-items:center;gap:7px;padding:10px 0;border-bottom:1px solid var(--border-color)}
.cr-drawer-item small{width:100%}
.cr-send-preview{margin-top:12px;font-size:12px;color:var(--text-secondary)}
.cr-send-preview ol{margin:8px 0;padding-left:20px}
.cr-send-preview li{padding:5px 0;overflow-wrap:anywhere}
.cr-send-preview li small{display:block}
.cr-drawer>textarea{width:100%;margin-top:12px;min-height:75px}
.cr-drawer>p{font-size:12px;color:var(--text-secondary)}
.cr-pane[data-medium=true] .cr-files{display:none}
.cr-pane[data-medium=true] .cr-files.open{display:block;position:absolute;inset:46px auto 0 0;z-index:7;box-shadow:6px 0 16px #0002}
.cr-pane[data-narrow=true] .cr-toolbar{padding:5px 8px}
.cr-pane[data-narrow=true] .cr-toolbar select{max-width:130px}
.cr-pane[data-narrow=true] .cr-drawer{width:100%}
.cr-pane[data-narrow=true] .cr-file-header strong{width:100%}
.cr-pane button[data-settings-button=icon]{width:32px!important;min-width:32px!important;height:32px!important;min-height:32px!important;display:inline-flex;align-items:center;justify-content:center;flex:0 0 32px;padding:6px!important;line-height:18px!important}
.cr-pane button[data-settings-button=icon] svg,.cr-pane button svg{pointer-events:none;display:block;flex:none}
.cr-pane .tok-keyword{color:var(--syntax-keyword,var(--accent-color))}
.cr-pane .tok-string,.cr-pane .tok-string2{color:var(--syntax-string,var(--success-color))}
.cr-pane .tok-regexp{color:var(--syntax-regexp,var(--syntax-string,var(--success-color)))}
.cr-pane .tok-number{color:var(--syntax-number,var(--warning-color))}
.cr-pane .tok-bool{color:var(--syntax-bool,var(--warning-color))}
.cr-pane .tok-atom{color:var(--syntax-atom,var(--warning-color))}
.cr-pane .tok-labelName{color:var(--syntax-label,var(--accent-color))}
.cr-pane .tok-variableName{color:var(--syntax-variable,var(--text-code,var(--text-primary)))}
.cr-pane .tok-variableName.tok-definition{color:var(--syntax-definition,var(--syntax-variable-definition,var(--accent-color)))}
.cr-pane .tok-variableName.tok-local{color:var(--syntax-local,var(--syntax-variable-local,var(--text-code,var(--text-primary))))}
.cr-pane .tok-variableName2{color:var(--syntax-variable2,var(--syntax-variable-special,var(--danger-color,var(--text-code,var(--text-primary)))))}
.cr-pane .tok-propertyName{color:var(--syntax-property,var(--danger-color,var(--text-code,var(--text-primary))))}
.cr-pane .tok-propertyName.tok-definition{color:var(--syntax-propertyDefinition,var(--syntax-definition,var(--syntax-variable-definition,var(--accent-color))))}
.cr-pane :is(.tok-variableName,.tok-propertyName).tok-function{color:var(--syntax-function,var(--syntax-definition,var(--syntax-variable-definition,var(--accent-color))))}
.cr-pane .tok-typeName{color:var(--syntax-type,var(--accent-color))}
.cr-pane .tok-className{color:var(--syntax-class,var(--syntax-type,var(--accent-color)))}
.cr-pane .tok-namespace{color:var(--syntax-namespace,var(--syntax-type,var(--accent-color)))}
.cr-pane .tok-macroName{color:var(--syntax-macro,var(--accent-color))}
.cr-pane .tok-comment{color:var(--syntax-comment,var(--text-secondary))}
.cr-pane .tok-meta{color:var(--syntax-meta,var(--text-secondary))}
.cr-pane .tok-operator{color:var(--syntax-operator,var(--text-code,var(--text-primary)))}
.cr-pane .tok-punctuation{color:var(--syntax-punctuation,var(--text-secondary,var(--text-code,var(--text-primary))))}
.cr-pane .tok-link{color:var(--syntax-link,var(--accent-color))}
.cr-pane .tok-heading{color:var(--syntax-heading,var(--accent-color))}
.cr-pane .tok-invalid{color:var(--syntax-invalid,var(--danger-color))}
.cr-pane .tok-deleted{color:var(--syntax-deleted,var(--danger-color))}
.cr-pane .tok-inserted{color:var(--syntax-inserted,var(--success-color))}
`;

export const actionStyles = `
/* Host-owned controls for every registered add-on Settings pane, in both skins.
 * Existing add-ons often supply inline button styles. Override only the control
 * appearance here; leave layout, visibility and event handling to the add-on.
 * Composite controls retain their own geometry. Custom widgets can opt out with
 * data-settings-button="unstyled"; ordinary buttons need no class or attribute.
 */
.cr-pane :where(button:not(.settings-number-step-btn):not(.settings-panel__stepper-btn):not([role="tab"]):not([role="switch"]):not([data-settings-button="unstyled"])) {
    appearance: none !important;
    box-sizing: border-box !important;
    min-height: var(--settings-addon-button-min-height, 32px) !important;
    min-width: var(--settings-addon-button-min-width, 0px) !important;
    padding: 6px 14px !important;
    border: 1px solid var(--border-color, var(--border)) !important;
    border-radius: 6px !important;
    background: var(--bg-hover, var(--bg-secondary)) !important;
    color: var(--text-primary) !important;
    font-family: var(--font-family, system-ui, sans-serif) !important;
    font-size: var(--settings-addon-button-font-size, 13px) !important;
    font-weight: var(--settings-addon-button-font-weight, 500) !important;
    line-height: var(--settings-addon-button-line-height, 18px) !important;
    white-space: var(--settings-addon-button-white-space, normal) !important;
    text-decoration: none !important;
    cursor: pointer !important;
    transition: var(--settings-addon-button-transition, background-color 0.15s, border-color 0.15s, color 0.15s) !important;
}

/* Keep Visual's generic span typography from changing button labels. */
.cr-pane button:not([data-settings-button="unstyled"]) span {
    font-size: inherit !important;
}

.cr-pane :where(button:not(.settings-number-step-btn):not(.settings-panel__stepper-btn):not([role="tab"]):not([role="switch"]):not([data-settings-button="unstyled"])):hover:not(:disabled):not([aria-disabled="true"]) {
    background: color-mix(in srgb, var(--accent-color) 15%, var(--bg-primary)) !important;
    border-color: var(--settings-addon-button-hover-border, var(--accent-color)) !important;
}

.cr-pane :where(button:not(.settings-number-step-btn):not(.settings-panel__stepper-btn):not([role="tab"]):not([role="switch"]):not([data-settings-button="unstyled"]))[aria-pressed="true"] {
    background: var(--accent-soft, color-mix(in srgb, var(--accent-color) 12%, transparent)) !important;
    border-color: var(--accent-color) !important;
}

.cr-pane button:not([data-settings-button="unstyled"]):focus-visible {
    outline: 2px solid var(--accent-color) !important;
    outline-offset: 2px !important;
}

.cr-pane button:not([data-settings-button="unstyled"]):is(:disabled, [aria-disabled="true"]) {
    opacity: var(--settings-addon-button-disabled-opacity, 0.55) !important;
    cursor: var(--settings-addon-button-disabled-cursor, not-allowed) !important;
}

.cr-pane button:is(.primary, [data-settings-button="primary"]):not([data-settings-button="unstyled"]) {
    background: var(--accent-color) !important;
    border-color: var(--accent-color) !important;
    color: var(--accent-contrast-text, #fff) !important;
}

.cr-pane button:is(.primary, [data-settings-button="primary"]):not([data-settings-button="unstyled"]):hover:not(:disabled):not([aria-disabled="true"]) {
    background: var(--accent-hover, var(--accent-color)) !important;
    color: var(--accent-contrast-text, #fff) !important;
}

.cr-pane button:is(.danger, [data-settings-button="danger"]):not([data-settings-button="unstyled"]) {
    color: var(--danger-color) !important;
}

.cr-pane button:is(.danger, [data-settings-button="danger"]):not([data-settings-button="unstyled"]):hover:not(:disabled):not([aria-disabled="true"]) {
    background: color-mix(in srgb, var(--danger-color) 12%, var(--bg-primary)) !important;
    border-color: var(--danger-color) !important;
}

.cr-pane button[data-settings-button="icon"] {
    min-width: 32px !important;
    padding: 6px !important;
}

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

@media (prefers-reduced-motion: reduce) {
    .cr-pane button:not([data-settings-button="unstyled"]) {
        transition: var(--settings-addon-button-transition, none) !important;
    }
}
`;
