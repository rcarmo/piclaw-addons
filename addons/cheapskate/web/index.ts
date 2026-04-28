/**
 * cheapskate/web/index.ts — Browser-side settings pane for cheapskate mode.
 *
 * Registers a "Cheapskate" pane in the settings dialog showing each free-tier
 * backend with enable/disable toggles and safety-cap checkboxes.
 * Config is persisted to .pi/cheapskate.json via the workspace file API.
 */
// @ts-nocheck
const CONFIG_PATH = '.pi/cheapskate.json';

const BACKENDS = [
    { id: 'google', name: 'Google Gemini', model: 'Gemini 2.5 Flash', keyEnv: 'GOOGLE_GENERATIVE_AI_API_KEY', context: '1M', hasSoftCap: false },
    { id: 'cerebras', name: 'Cerebras', model: 'Qwen 3 235B', keyEnv: 'CEREBRAS_API_KEY', context: '131K', hasSoftCap: false },
    { id: 'groq', name: 'Groq', model: 'QwQ 32B', keyEnv: 'GROQ_API_KEY', context: '131K', hasSoftCap: false },
    { id: 'sambanova', name: 'SambaNova', model: 'DeepSeek R1', keyEnv: 'SAMBANOVA_API_KEY', context: '65K', hasSoftCap: false },
    { id: 'openrouter', name: 'OpenRouter', model: 'DeepSeek R1 (free)', keyEnv: 'OPENROUTER_API_KEY', context: '163K', hasSoftCap: false },
    { id: 'cloudflare', name: 'Cloudflare Workers AI', model: 'Llama 3.3 70B', keyEnv: 'CLOUDFLARE_API_TOKEN', context: '131K', hasSoftCap: true, softCapWarning: 'Workers Paid plan auto-bills overages at $0.011/1K Neurons. Enable safety cap to hard-limit at 10K Neurons/day.' },
];

async function loadConfig() {
    try {
        const resp = await fetch(`/workspace/file?path=${encodeURIComponent(CONFIG_PATH)}&mode=read`);
        if (!resp.ok) return {};
        const text = await resp.text();
        return JSON.parse(text);
    } catch { return {}; }
}

async function saveConfig(config) {
    try {
        await fetch('/workspace/file', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: CONFIG_PATH, content: JSON.stringify(config, null, 2) }),
        });
    } catch (e) { console.error('Failed to save cheapskate config:', e); }
}

function registerPane() {
    const { registerSettingsPane, notifySettingsPanesChanged } = globalThis.__piclawSettingsPaneRegistry || {};
    if (!registerSettingsPane) {
        // Try the module import path
        try {
            const mod = require('../../components/settings/pane-registry.js');
            registerSettingsPane = mod.registerSettingsPane;
        } catch { return; }
    }

    const icon = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/></svg>`;

    registerSettingsPane({
        id: 'cheapskate',
        label: 'Cheapskate',
        icon,
        order: 35,
        searchable: false,
        component: CheapskatePane,
    });
}

function CheapskatePane() {
    const { html, useState, useEffect, useCallback } = globalThis.__piclawPreact || {};
    if (!html) return null;

    const [config, setConfig] = useState(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => { loadConfig().then(setConfig); }, []);

    const updateBackend = useCallback(async (id, field, value) => {
        const updated = { ...config, backends: { ...(config?.backends || {}) } };
        updated.backends[id] = { ...(updated.backends?.[id] || {}), [field]: value };
        setConfig(updated);
        setSaving(true);
        await saveConfig(updated);
        setSaving(false);
    }, [config]);

    if (!config) return html`<div class="settings-loading">Loading cheapskate config…</div>`;

    const backends = config?.backends || {};

    return html`
        <div class="cheapskate-settings">
            <p class="settings-hint" style="margin: 0 0 16px">
                Select which free-tier backends are available for rotation.
                Only backends with a configured API key can be used.
                ${saving ? html` <em>Saving…</em>` : ''}
            </p>
            <table class="settings-table">
                <thead>
                    <tr>
                        <th style="width:40px">On</th>
                        <th>Provider</th>
                        <th>Model</th>
                        <th>Context</th>
                        <th style="width:80px;text-align:center">Safety cap</th>
                    </tr>
                </thead>
                <tbody>
                    ${BACKENDS.map(b => {
                        const bc = backends[b.id] || {};
                        const enabled = bc.enabled !== false; // default on
                        const safetyCap = bc.safetyCap !== false; // default on for soft-cap providers
                        return html`
                            <tr>
                                <td>
                                    <input type="checkbox" checked=${enabled}
                                        onChange=${() => updateBackend(b.id, 'enabled', !enabled)}
                                        title=${`${enabled ? 'Disable' : 'Enable'} ${b.name}`} />
                                </td>
                                <td>
                                    <strong>${b.name}</strong>
                                    ${b.hasSoftCap ? html`<span style="color:var(--warning-color,#f0ad4e);margin-left:6px" title=${b.softCapWarning}>⚠️</span>` : ''}
                                </td>
                                <td style="opacity:0.8">${b.model}</td>
                                <td style="opacity:0.7">${b.context}</td>
                                <td style="text-align:center">
                                    ${b.hasSoftCap
                                        ? html`<input type="checkbox" checked=${safetyCap}
                                            onChange=${() => updateBackend(b.id, 'safetyCap', !safetyCap)}
                                            title="Enable hard daily limit to prevent overage billing" />`
                                        : html`<span style="opacity:0.3" title="Hard-capped by provider (no billing risk)">—</span>`
                                    }
                                </td>
                            </tr>
                        `;
                    })}
                </tbody>
            </table>
            <div class="settings-hint" style="margin-top:12px;font-size:12px">
                <strong>Safety cap</strong> prevents a backend from being used after its free daily allocation is estimated to be exhausted.
                Providers without ⚠️ are hard-capped — they return errors at the limit and never charge.
                Cloudflare Workers AI ⚠️ may auto-bill overages if you have a Workers Paid plan ($5/mo).
            </div>
        </div>
    `;
}

// ── Registration ─────────────────────────────────────────────────
// Try to register immediately if the settings pane registry is available,
// otherwise wait for the global hooks to be set up.

if (typeof globalThis !== 'undefined') {
    try { registerPane(); } catch { /* will be registered later */ }
    if (typeof window !== 'undefined') {
        window.addEventListener('piclaw:addons-loaded', () => { try { registerPane(); } catch {} });
    }
}
