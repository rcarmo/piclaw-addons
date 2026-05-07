/**
 * cheapskate/web/index.ts — Browser-side settings pane for cheapskate mode.
 *
 * Config (enabled/disabled, safety caps) stored in extension KV via API.
 * API keys stored in keychain via POST /agent/keychain.
 */
// @ts-nocheck
const BACKENDS = [
    { id: 'google', name: 'Google Gemini', model: 'Gemini 2.5 Flash', context: '1M', keychainName: 'google/generative-ai-api-key', hasSoftCap: false },
    { id: 'cerebras', name: 'Cerebras', model: 'Qwen 3 235B', context: '131K', keychainName: 'cerebras/api-key', hasSoftCap: false },
    { id: 'groq', name: 'Groq', model: 'QwQ 32B', context: '131K', keychainName: 'groq/api-key', hasSoftCap: false },
    { id: 'sambanova', name: 'SambaNova', model: 'DeepSeek R1', context: '65K', keychainName: 'sambanova/api-key', hasSoftCap: false },
    { id: 'openrouter', name: 'OpenRouter', model: 'DeepSeek R1 (free)', context: '163K', keychainName: 'openrouter/api-key', hasSoftCap: false },
    { id: 'opencode', name: 'OpenCode Zen', model: 'GPT OSS 120B', context: '128K', keychainName: 'opencode/api-key', hasSoftCap: false },
    { id: 'nvidia', name: 'NVIDIA NIM', model: 'Llama 3.3 70B', context: '131K', keychainName: 'nvidia/api-key', hasSoftCap: false },
    { id: 'cloudflare', name: 'Cloudflare Workers AI', model: 'Llama 3.3 70B', context: '131K', keychainName: 'cloudflare/api-token', hasSoftCap: true, softCapWarning: 'Workers Paid plan auto-bills overages at $0.011/1K Neurons.' },
];

const API = '/agent/addons/api/cheapskate';

async function loadConfig() {
    try { const r = await fetch(`${API}/config`); return r.ok ? await r.json() : {}; }
    catch { return {}; }
}

async function saveField(patch) {
    try { await fetch(`${API}/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }); }
    catch (e) { console.error('cheapskate config save failed', e); }
}

async function loadKeychainStatus() {
    try {
        const r = await fetch('/agent/keychain');
        if (!r.ok) return {};
        const data = await r.json();
        const entries = data.entries || [];
        const map = {};
        for (const e of entries) map[e.name] = true;
        return map;
    } catch { return {}; }
}

async function setKeychainKey(name, secret) {
    try {
        await fetch('/agent/keychain', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, secret, type: 'token' }),
        });
        return true;
    } catch { return false; }
}

function registerPane() {
    let reg, notify;
    const r = globalThis.__piclawSettingsPaneRegistry;
    if (r) { reg = r.registerSettingsPane; notify = r.notifySettingsPanesChanged; }
    if (!reg) { try { const m = require('../../components/settings/pane-registry.js'); reg = m.registerSettingsPane; notify = m.notifySettingsPanesChanged; } catch { return; } }

    const icon = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/></svg>`;

    reg({ id: 'cheapskate', label: 'Cheapskate', icon, order: 35, searchable: false, component: CheapskatePane });
    notify?.();
}

function CheapskatePane() {
    const { html, useState, useEffect, useCallback } = globalThis.__piclawPreact || {};
    if (!html) return null;

    const [config, setConfig] = useState(null);
    const [keychainMap, setKeychainMap] = useState({});
    const [saving, setSaving] = useState(false);
    const [keyInputs, setKeyInputs] = useState({});
    const [msg, setMsg] = useState('');

    useEffect(() => {
        loadConfig().then(setConfig);
        loadKeychainStatus().then(setKeychainMap);
    }, []);

    const updateBackend = useCallback(async (id, field, value) => {
        const patch = { backends: { ...(config?.backends || {}), [id]: { ...(config?.backends?.[id] || {}), [field]: value } } };
        setConfig(c => ({ ...c, ...patch }));
        setSaving(true);
        await saveField(patch);
        setSaving(false);
    }, [config]);

    const saveKey = useCallback(async (b) => {
        const secret = (keyInputs[b.id] || '').trim();
        if (!secret) return;
        setSaving(true);
        const ok = await setKeychainKey(b.keychainName, secret);
        setSaving(false);
        if (ok) {
            setKeychainMap(m => ({ ...m, [b.keychainName]: true }));
            setKeyInputs(k => ({ ...k, [b.id]: '' }));
            setMsg(`Saved ${b.name} key. Restart required for the runtime to pick it up.`);
            setTimeout(() => setMsg(''), 5000);
        } else {
            setMsg(`Failed to save ${b.name} key.`);
        }
    }, [keyInputs]);

    if (!config) return html`<div style="padding:1rem;color:var(--text-secondary)">Loading…</div>`;

    const backends = config?.backends || {};
    const S = { display: 'flex', alignItems: 'center', gap: '0.5rem', margin: '0.3rem 0' };
    const L = { minWidth: '140px', color: 'var(--text-secondary)', fontSize: '0.85rem' };
    const I = { flex: 1, padding: '4px 8px', background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: '4px', fontSize: '0.82rem', fontFamily: 'var(--font-mono, monospace)' };

    return html`
        <div style="padding:0.5rem 0;">
            <p style="margin:0 0 1rem;font-size:0.85rem;color:var(--text-secondary)">
                Free-tier provider rotation. Enable backends below and provide API keys.
                ${saving ? html` <em>Saving…</em>` : ''}
            </p>
            ${BACKENDS.map(b => {
                const bc = backends[b.id] || {};
                const enabled = bc.enabled !== false;
                const safetyCap = bc.safetyCap !== false;
                const hasKey = !!keychainMap[b.keychainName];
                const keyValue = keyInputs[b.id] || '';
                return html`
                    <div style="border:1px solid var(--border-color);border-radius:8px;padding:0.75rem;margin:0.6rem 0;">
                        <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.4rem;">
                            <input type="checkbox" checked=${enabled} onChange=${() => updateBackend(b.id, 'enabled', !enabled)} />
                            <strong style="font-size:0.92rem">${b.name}</strong>
                            <span style="font-size:0.78rem;color:var(--text-secondary);margin-left:auto">${b.model} · ${b.context}</span>
                            ${hasKey
                                ? html`<span style="font-size:0.72rem;color:var(--accent-color,#2563eb);font-weight:600" title="Key in keychain">✓ key</span>`
                                : html`<span style="font-size:0.72rem;color:var(--danger-color,#dc2626);font-weight:600" title="No key found">✗ no key</span>`
                            }
                        </div>
                        <div style=${S}>
                            <span style=${L}>API key</span>
                            <input type="password" value=${keyValue} style=${I}
                                placeholder=${hasKey ? '••••••• (stored in keychain)' : 'paste key here'}
                                onInput=${(e) => setKeyInputs(k => ({ ...k, [b.id]: e.target.value }))}
                                onKeyDown=${(e) => { if (e.key === 'Enter') saveKey(b); }}
                            />
                            <button style="padding:4px 10px;border:1px solid var(--border-color);border-radius:4px;background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;font-size:0.82rem"
                                onClick=${() => saveKey(b)} disabled=${!keyValue.trim() || saving}>Save</button>
                        </div>
                        ${b.hasSoftCap ? html`
                            <div style=${S}>
                                <span style=${L}>Safety cap</span>
                                <input type="checkbox" checked=${safetyCap} onChange=${() => updateBackend(b.id, 'safetyCap', !safetyCap)} />
                                <span style="font-size:0.75rem;color:var(--text-secondary)">${b.softCapWarning}</span>
                            </div>
                        ` : ''}
                    </div>
                `;
            })}
            ${msg && html`<div style="margin-top:0.75rem;font-size:0.8rem;color:var(--accent-color,#2563eb)">${msg}</div>`}
            <div style="margin-top:0.8rem;font-size:0.75rem;color:var(--text-secondary)">
                Keys are stored in the piclaw keychain, not in config files. A restart is needed after adding or changing a key.
            </div>
        </div>`;
}

if (typeof globalThis !== 'undefined') {
    try { registerPane(); } catch {}
    if (typeof window !== 'undefined') {
        window.addEventListener('piclaw:addons-loaded', () => { try { registerPane(); } catch {} });
    }
}
