// @ts-nocheck
import { resticStyles } from "./styles.ts";

const ADDON_ID = "restic";
const API = `/agent/addons/api/${ADDON_ID}`;
const KEYCHAIN_ENDPOINT = "/agent/keychain";
const INIT_CONFIRMATION = "INITIALISE REPOSITORY";
const RESTORE_CONFIRMATION = "RESTORE TO EMPTY DIRECTORY";
const RETENTION_CONFIRMATION = "DELETE PREVIEWED SNAPSHOTS";

const preactHtm = globalThis.__piclawPreactHtm || globalThis.__piclawPreact || null;
const html = preactHtm?.html;
const useState = preactHtm?.useState;
const useEffect = preactHtm?.useEffect;
const useCallback = preactHtm?.useCallback;
const HAS_RUNTIME = Boolean(html && useState && useEffect && useCallback);

const ICON = HAS_RUNTIME
  ? html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 5h14v14H5z"/><path d="M8 8h8v3H8z"/><path d="M8 14h8"/><path d="M8 17h5"/></svg>`
  : null;

const DEFAULT_CONFIG = {
  enabled: false,
  repository: null,
  passwordRef: "",
  retention: { enabled: false, hourly: 24, daily: 7, weekly: 4, monthly: 6 },
  binary: "managed",
  excludes: [],
  schedule: { enabled: false, hours: [0], minute: 0, timezone: "UTC" },
};

function defaultRepository(backend) {
  switch (backend) {
    case "sftp": return { backend, host: "", port: 22, user: "", path: "", privateKeyRef: "", knownHostsRef: "" };
    case "s3": return { backend, endpoint: "", region: "us-east-1", bucket: "", prefix: "", accessKeyRef: "", secretKeyRef: "", sessionTokenRef: "" };
    case "azure": return { backend, account: "", container: "", prefix: "", accountKeyRef: "" };
    default: return { backend: "local", path: "", expectedMount: "" };
  }
}

function withDefaults(config) {
  const c = config && typeof config === "object" ? config : {};
  return {
    ...DEFAULT_CONFIG,
    ...c,
    repository: c.repository || null,
    retention: { ...DEFAULT_CONFIG.retention, ...(c.retention || {}) },
    excludes: Array.isArray(c.excludes) ? c.excludes : [],
    schedule: { ...DEFAULT_CONFIG.schedule, ...(c.schedule || {}), hours: Array.isArray(c.schedule?.hours) ? c.schedule.hours : DEFAULT_CONFIG.schedule.hours },
  };
}

function normalizeRepository(repo) {
  if (!repo || typeof repo !== "object") return null;
  if (repo.backend === "local") return { backend: "local", path: repo.path || "", ...(repo.expectedMount ? { expectedMount: repo.expectedMount } : {}) };
  if (repo.backend === "sftp") return { backend: "sftp", host: repo.host || "", port: Number(repo.port || 22), user: repo.user || "", path: repo.path || "", privateKeyRef: repo.privateKeyRef || "", knownHostsRef: repo.knownHostsRef || "" };
  if (repo.backend === "s3") return { backend: "s3", endpoint: repo.endpoint || "", region: repo.region || "", bucket: repo.bucket || "", prefix: repo.prefix || "", accessKeyRef: repo.accessKeyRef || "", secretKeyRef: repo.secretKeyRef || "", ...(repo.sessionTokenRef ? { sessionTokenRef: repo.sessionTokenRef } : {}) };
  if (repo.backend === "azure") return { backend: "azure", account: repo.account || "", container: repo.container || "", prefix: repo.prefix || "", accountKeyRef: repo.accountKeyRef || "" };
  return null;
}

function parseHours(text) {
  const raw = String(text || "").split(",").map(part => part.trim()).filter(Boolean);
  if (!raw.length) throw Error("Schedule hours must include at least one hour.");
  const hours = raw.map(part => Number(part));
  if (hours.some(hour => !Number.isInteger(hour) || hour < 0 || hour > 23)) throw Error("Schedule hours must be comma-separated integers from 0 to 23.");
  return [...new Set(hours)].sort((a, b) => a - b);
}

function toSaveConfig(draft, hoursText) {
  const minute = Number(draft.schedule?.minute ?? 0);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw Error("Schedule minute must be an integer from 0 to 59.");
  return {
    enabled: Boolean(draft.enabled),
    repository: normalizeRepository(draft.repository),
    passwordRef: draft.passwordRef || "",
    retention: {
      enabled: Boolean(draft.retention?.enabled),
      hourly: Number(draft.retention?.hourly ?? 0),
      daily: Number(draft.retention?.daily ?? 0),
      weekly: Number(draft.retention?.weekly ?? 0),
      monthly: Number(draft.retention?.monthly ?? 0),
    },
    binary: draft.binary || "managed",
    excludes: Array.isArray(draft.excludes) ? draft.excludes.map(x => String(x).trim()).filter(Boolean) : [],
    schedule: {
      enabled: Boolean(draft.schedule?.enabled),
      hours: parseHours(hoursText),
      minute,
      timezone: draft.schedule?.timezone || "UTC",
    },
  };
}

function extractError(data, fallback) {
  const e = data?.error;
  if (typeof e === "string") return e;
  if (typeof e?.message === "string") return e.message;
  if (typeof data?.message === "string") return data.message;
  return fallback;
}

function redactText(value) {
  return String(value ?? "")
    .replace(/((?:password|secret|token|private[_ -]?key)\s*[=:]\s*)([^\s,;]+)/gi, "$1[redacted]")
    .replace(/("(?:password|secret|token|privateKey)"\s*:\s*")([^"]+)(")/gi, "$1[redacted]$3");
}

function jsonText(value) {
  try { return redactText(JSON.stringify(value, null, 2)); }
  catch { return redactText(String(value)); }
}

async function api(path, body) {
  const response = await fetch(`${API}/${path}`, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) throw Error(redactText(extractError(data, "Request failed")));
  return data;
}

async function loadKeychainNames() {
  const response = await fetch(KEYCHAIN_ENDPOINT);
  if (!response.ok) throw Error("Could not load keychain names.");
  const data = await response.json().catch(() => ({}));
  const entries = Array.isArray(data?.entries) ? data.entries : Array.isArray(data) ? data : [];
  return [...new Set(entries.map(entry => String(entry?.name || "")).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function snapshotId(snapshot) {
  return snapshot?.id || snapshot?.short_id || snapshot?.snapshot || snapshot?.snapshotId || "";
}

function extractSnapshots(result) {
  const source = result?.snapshots || result?.snapshotList || result?.result?.snapshots || (Array.isArray(result) ? result : []);
  return Array.isArray(source) ? source : [];
}

function extractRetentionPreview(result) {
  const r = result?.result || result || {};
  const preview = r.preview || r.retention || r;
  const ids = preview.ids || preview.snapshotIds || preview.deleteIds || preview.snapshots?.map(snapshotId).filter(Boolean) || [];
  return { token: preview.token || preview.previewToken || r.token || "", ids: Array.isArray(ids) ? ids : [] };
}

function formatDate(value) {
  if (!value) return "never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function describeRepo(repo) {
  if (!repo) return "not configured";
  if (repo.backend === "local") return repo.path || "local path not set";
  if (repo.backend === "sftp") return `${repo.user || "user"}@${repo.host || "host"}:${repo.port || 22}${repo.path || "/path"}`;
  if (repo.backend === "s3") return `${repo.endpoint || "https://endpoint"}/${repo.bucket || "bucket"}/${repo.prefix || ""}`;
  if (repo.backend === "azure") return `${repo.account || "account"}/${repo.container || "container"}/${repo.prefix || ""}`;
  return repo.backend || "unknown";
}

function keyOptions(names) {
  return html`<datalist id="restic-keychain-names">${names.map(name => html`<option value=${name} />`)}</datalist>`;
}

function KeyRefField({ id, label, value, onInput, names, help }) {
  return html`<div class="settings-addon-field">
    <label class="settings-addon-label" for=${id}>${label}</label>
    <input id=${id} class="settings-addon-control restic-mono" type="text" list="restic-keychain-names" value=${value || ""} onInput=${e => onInput(e.target.value)} autocomplete="off" />
    <span class="settings-addon-help">${help || "Keychain name only. Create or update the secret in Settings → Keychain first."}</span>
  </div>`;
}

function NumberField({ id, label, value, min, max, onInput }) {
  return html`<div class="settings-addon-field">
    <label class="settings-addon-label" for=${id}>${label}</label>
    <input id=${id} class="settings-addon-control" type="number" min=${min ?? 0} max=${max ?? 10000} step="1" value=${value ?? 0} onInput=${e => onInput(Number(e.target.value))} />
  </div>`;
}

function RepoFields({ repo, onRepo, keyNames }) {
  const view = repo || defaultRepository("local");
  const setBackend = backend => onRepo(defaultRepository(backend));
  const patch = update => onRepo({ ...defaultRepository(view.backend), ...view, ...update });
  return html`<div>
    <div class="settings-addon-field">
      <label class="settings-addon-label" for="restic-repository-backend">Repository backend</label>
      <select id="restic-repository-backend" class="settings-addon-control" value=${view.backend} onChange=${e => setBackend(e.target.value)}>
        <option value="local">Local / mounted filesystem</option>
        <option value="sftp">SFTP</option>
        <option value="s3">S3-compatible</option>
        <option value="azure">Azure Blob</option>
      </select>
      <span class="settings-addon-help">This pane stores locations and keychain reference names only, not credential values.</span>
    </div>

    ${view.backend === "local" && html`<div class="restic-compact-grid">
      <div class="settings-addon-field">
        <label class="settings-addon-label" for="restic-local-path">Repository path</label>
        <input id="restic-local-path" class="settings-addon-control restic-mono" type="text" value=${view.path || ""} placeholder="/mnt/backups/restic" onInput=${e => patch({ path: e.target.value })} />
      </div>
      <div class="settings-addon-field">
        <label class="settings-addon-label" for="restic-local-mount">Expected mount (optional)</label>
        <input id="restic-local-mount" class="settings-addon-control restic-mono" type="text" value=${view.expectedMount || ""} placeholder="/mnt/backups" onInput=${e => patch({ expectedMount: e.target.value })} />
      </div>
    </div>`}

    ${view.backend === "sftp" && html`<div class="restic-compact-grid">
      <div class="settings-addon-field"><label class="settings-addon-label" for="restic-sftp-host">Host</label><input id="restic-sftp-host" class="settings-addon-control" type="text" value=${view.host || ""} onInput=${e => patch({ host: e.target.value })} /></div>
      <${NumberField} id="restic-sftp-port" label="Port" min=${1} max=${65535} value=${view.port || 22} onInput=${value => patch({ port: value })} />
      <div class="settings-addon-field"><label class="settings-addon-label" for="restic-sftp-user">User</label><input id="restic-sftp-user" class="settings-addon-control" type="text" value=${view.user || ""} onInput=${e => patch({ user: e.target.value })} /></div>
      <div class="settings-addon-field"><label class="settings-addon-label" for="restic-sftp-path">Remote path</label><input id="restic-sftp-path" class="settings-addon-control restic-mono" type="text" value=${view.path || ""} placeholder="/srv/restic" onInput=${e => patch({ path: e.target.value })} /></div>
      <${KeyRefField} id="restic-sftp-key" label="SSH private key ref" names=${keyNames} value=${view.privateKeyRef || ""} onInput=${value => patch({ privateKeyRef: value })} />
      <${KeyRefField} id="restic-sftp-known-hosts" label="SSH known-hosts ref" names=${keyNames} value=${view.knownHostsRef || ""} onInput=${value => patch({ knownHostsRef: value })} />
    </div>`}

    ${view.backend === "s3" && html`<div class="restic-compact-grid">
      <div class="settings-addon-field"><label class="settings-addon-label" for="restic-s3-endpoint">HTTPS endpoint</label><input id="restic-s3-endpoint" class="settings-addon-control restic-mono" type="url" value=${view.endpoint || ""} placeholder="https://s3.example.com" onInput=${e => patch({ endpoint: e.target.value })} /></div>
      <div class="settings-addon-field"><label class="settings-addon-label" for="restic-s3-region">Region</label><input id="restic-s3-region" class="settings-addon-control" type="text" value=${view.region || ""} placeholder="us-east-1" onInput=${e => patch({ region: e.target.value })} /></div>
      <div class="settings-addon-field"><label class="settings-addon-label" for="restic-s3-bucket">Bucket</label><input id="restic-s3-bucket" class="settings-addon-control" type="text" value=${view.bucket || ""} onInput=${e => patch({ bucket: e.target.value })} /></div>
      <div class="settings-addon-field"><label class="settings-addon-label" for="restic-s3-prefix">Prefix</label><input id="restic-s3-prefix" class="settings-addon-control restic-mono" type="text" value=${view.prefix || ""} placeholder="smith/daily" onInput=${e => patch({ prefix: e.target.value })} /></div>
      <${KeyRefField} id="restic-s3-access" label="Access key ref" names=${keyNames} value=${view.accessKeyRef || ""} onInput=${value => patch({ accessKeyRef: value })} />
      <${KeyRefField} id="restic-s3-secret" label="Secret key ref" names=${keyNames} value=${view.secretKeyRef || ""} onInput=${value => patch({ secretKeyRef: value })} />
      <${KeyRefField} id="restic-s3-session" label="Session token ref (optional)" names=${keyNames} value=${view.sessionTokenRef || ""} onInput=${value => patch({ sessionTokenRef: value })} />
    </div>`}

    ${view.backend === "azure" && html`<div class="restic-compact-grid">
      <div class="settings-addon-field"><label class="settings-addon-label" for="restic-azure-account">Account</label><input id="restic-azure-account" class="settings-addon-control" type="text" value=${view.account || ""} onInput=${e => patch({ account: e.target.value })} /></div>
      <div class="settings-addon-field"><label class="settings-addon-label" for="restic-azure-container">Container</label><input id="restic-azure-container" class="settings-addon-control" type="text" value=${view.container || ""} onInput=${e => patch({ container: e.target.value })} /></div>
      <div class="settings-addon-field"><label class="settings-addon-label" for="restic-azure-prefix">Prefix</label><input id="restic-azure-prefix" class="settings-addon-control restic-mono" type="text" value=${view.prefix || ""} onInput=${e => patch({ prefix: e.target.value })} /></div>
      <${KeyRefField} id="restic-azure-key" label="Account key ref" names=${keyNames} value=${view.accountKeyRef || ""} onInput=${value => patch({ accountKeyRef: value })} />
    </div>`}
  </div>`;
}

function StatusCard({ title, value }) {
  return html`<div class="restic-card">
    <div class="restic-card-header"><strong>${title}</strong><span class="restic-pill">${value?.status || value?.state || "unknown"}</span></div>
    ${value ? html`<pre class="restic-json">${jsonText(value)}</pre>` : html`<p class="settings-addon-help">No ${title.toLowerCase()} status reported.</p>`}
  </div>`;
}

function ResticSettings() {
  if (!HAS_RUNTIME) return null;
  const [draft, setDraft] = useState(null);
  const [paths, setPaths] = useState(null);
  const [binary, setBinary] = useState(null);
  const [migration, setMigration] = useState(null);
  const [status, setStatus] = useState(null);
  const [keyNames, setKeyNames] = useState([]);
  const [hoursText, setHoursText] = useState("0");
  const [restoreSnapshot, setRestoreSnapshot] = useState("");
  const [restoreTarget, setRestoreTarget] = useState("");
  const [snapshots, setSnapshots] = useState([]);
  const [preview, setPreview] = useState({ token: "", ids: [] });
  const [busy, setBusy] = useState(false);
  const [configBusy, setConfigBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [receipt, setReceipt] = useState(null);

  const loadConfig = useCallback(async () => {
    const data = await api("config");
    const config = withDefaults(data.config);
    setDraft(config);
    setPaths(data.paths || null);
    setBinary(data.binary || null);
    setMigration(data.migration || null);
    setHoursText((config.schedule?.hours || [0]).join(","));
  }, []);

  const loadStatus = useCallback(async () => {
    const data = await api("status");
    setStatus(data.state || null);
  }, []);

  const loadKeys = useCallback(async () => setKeyNames(await loadKeychainNames()), []);

  const loadInitial = useCallback(async () => {
    setError(""); setMessage("Loading Restic settings…");
    try { await Promise.all([loadConfig(), loadStatus(), loadKeys()]); setMessage(""); }
    catch (e) { setError(e.message || "Could not load Restic settings."); setMessage(""); }
  }, [loadConfig, loadStatus, loadKeys]);

  useEffect(() => { void loadInitial(); }, [loadInitial]);

  const update = patch => { setDraft(current => ({ ...current, ...patch })); setMessage("Unsaved changes"); setError(""); };
  const updateRetention = patch => update({ retention: { ...draft.retention, ...patch } });
  const updateSchedule = patch => update({ schedule: { ...draft.schedule, ...patch } });
  const updateRepo = repo => update({ repository: repo });

  async function saveConfig() {
    setConfigBusy(true); setError(""); setMessage("");
    try {
      const config = toSaveConfig(draft, hoursText);
      const data = await api("config", { config });
      const saved = withDefaults(data.config || config);
      setDraft(saved);
      setHoursText((saved.schedule?.hours || [0]).join(","));
      setMessage("Configuration saved. Use Test connection before enabling scheduled backups.");
    } catch (e) { setError(e.message || "Save failed."); }
    finally { setConfigBusy(false); }
  }

  async function refreshStatus() {
    setBusy(true); setError("");
    try { await Promise.all([loadStatus(), loadConfig()]); setMessage("Status refreshed."); }
    catch (e) { setError(e.message || "Status refresh failed."); }
    finally { setBusy(false); }
  }

  async function runAction(payload) {
    setBusy(true); setError(""); setMessage(""); setReceipt(null);
    try {
      const data = await api("action", payload);
      const result = data.result ?? data;
      setReceipt(result);
      if (data.state) setStatus(data.state);
      if (payload.action === "snapshots") {
        const list = extractSnapshots(result);
        setSnapshots(list);
        if (list.length && !restoreSnapshot) setRestoreSnapshot(snapshotId(list[0]));
      }
      if (payload.action === "previewRetention") {
        const next = extractRetentionPreview(result);
        setPreview(next);
      }
      if(payload.action === "installBinary") await loadConfig();
      setMessage(data.queued ? "Operation queued. Use Refresh status to follow progress." : "Action completed.");
    } catch (e) { setError(e.message || "Action failed."); }
    finally { setBusy(false); }
  }

  function confirmAndRun(action, confirmation, message) {
    if (window.confirm(message)) void runAction({ action, confirmation });
  }

  function destructive(label, confirmation, payload, enabled = true) {
    return html`<button class="restic-danger" disabled=${busy || !enabled} onClick=${() => {
      if (!window.confirm(`${label}? This is destructive and requires confirmation payload: ${confirmation}`)) return;
      void runAction({ ...payload, confirmation });
    }}>${label}</button>`;
  }

  if (!draft) return html`<div class="restic-settings"><style>${resticStyles}</style><p class="settings-addon-status" role="status">${error || message || "Loading Restic…"}</p></div>`;

  const running = Boolean(status?.running);
  const logs = Array.isArray(status?.logs) ? status.logs.join("\n") : status?.logs || "";
  const selectedSnapshot = restoreSnapshot || (snapshots[0] && snapshotId(snapshots[0])) || "";

  return html`<div class="restic-settings">
    <style>${resticStyles}</style>
    ${keyOptions(keyNames)}

    <section class="restic-section">
      <h4>Restic backup</h4>
      <div class="restic-status-line">
        <span class="restic-pill">${draft.enabled ? "enabled" : "disabled"}</span>
        <span class="restic-pill">${draft.repository?.backend || "no repository"}</span>
        <span class="restic-muted">${describeRepo(draft.repository)}</span>
      </div>
      <label class="restic-check"><input type="checkbox" checked=${draft.enabled} onChange=${e => update({ enabled: e.target.checked })} /> Enable Restic backup</label>
    </section>

    <section class="restic-section">
      <h4>Repository and credentials</h4>
      <button type="button" class="settings-addon-button" disabled=${busy || status?.running} onClick=${() => confirmAndRun("installBinary", "INSTALL VERIFIED RESTIC", "Download checksum-verified upstream Restic 0.18.1 for this add-on and select it? No system binary or backup job is changed.")}>Install verified Restic</button>
    <${RepoFields} repo=${draft.repository} onRepo=${updateRepo} keyNames=${keyNames} />
      <div class="restic-compact-grid">
        <${KeyRefField} id="restic-password-ref" label="Repository password ref" names=${keyNames} value=${draft.passwordRef} onInput=${value => update({ passwordRef: value })} help="Restic repository password keychain name. Create it in Settings → Keychain first." />
        <div class="settings-addon-field">
          <label class="settings-addon-label" for="restic-binary">Restic binary</label>
          <input id="restic-binary" class="settings-addon-control restic-mono" type="text" value=${draft.binary || "managed"} onInput=${e => update({ binary: e.target.value })} />
          <span class="settings-addon-help">Use <code>managed</code> (default), <code>restic</code> from PATH, or an explicit path. Install is required before the first managed operation. detected ${binary?.path || "path unknown"}${binary?.version ? ` · ${binary.version}` : ""}.</span>
        </div>
      </div>
      <div class="restic-row"><button type="button" onClick=${() => loadKeys().catch(e => setError(e.message))} disabled=${busy || configBusy}>Refresh key names</button><span class="settings-addon-help">Names only are fetched; this pane never creates or displays secrets.</span></div>
    </section>

    <section class="restic-section">
      <h4>Retention</h4>
      <label class="restic-check"><input type="checkbox" checked=${draft.retention.enabled} onChange=${e => updateRetention({ enabled: e.target.checked })} /> Enable retention configuration</label>
      <div class="restic-compact-grid">
        <${NumberField} id="restic-retention-hourly" label="Hourly" value=${draft.retention.hourly} onInput=${value => updateRetention({ hourly: value })} />
        <${NumberField} id="restic-retention-daily" label="Daily" value=${draft.retention.daily} onInput=${value => updateRetention({ daily: value })} />
        <${NumberField} id="restic-retention-weekly" label="Weekly" value=${draft.retention.weekly} onInput=${value => updateRetention({ weekly: value })} />
        <${NumberField} id="restic-retention-monthly" label="Monthly" value=${draft.retention.monthly} onInput=${value => updateRetention({ monthly: value })} />
      </div>
      <p class="settings-addon-help">Preview retention before applying. Apply retention deletes only the previewed snapshot IDs with the returned token.</p>
    </section>

    <section class="restic-section">
      <h4>Schedule and excludes</h4>
      <label class="restic-check"><input type="checkbox" checked=${draft.schedule.enabled} onChange=${e => updateSchedule({ enabled: e.target.checked })} /> Enable Restic scheduler</label>
      <div class="restic-three-grid">
        <div class="settings-addon-field"><label class="settings-addon-label" for="restic-schedule-hours">Hours UTC/local TZ</label><input id="restic-schedule-hours" class="settings-addon-control" type="text" value=${hoursText} placeholder="0,6,12,18" onInput=${e => { setHoursText(e.target.value); setMessage("Unsaved changes"); }} /><span class="settings-addon-help">Comma-separated 0–23.</span></div>
        <${NumberField} id="restic-schedule-minute" label="Minute" min=${0} max=${59} value=${draft.schedule.minute} onInput=${value => updateSchedule({ minute: value })} />
        <div class="settings-addon-field"><label class="settings-addon-label" for="restic-timezone">Timezone</label><input id="restic-timezone" class="settings-addon-control" type="text" value=${draft.schedule.timezone || "UTC"} placeholder="UTC" onInput=${e => updateSchedule({ timezone: e.target.value })} /></div>
      </div>
      <div class="settings-addon-field">
        <label class="settings-addon-label" for="restic-excludes">Excludes</label>
        <textarea id="restic-excludes" class="settings-addon-control restic-mono" rows="4" value=${(draft.excludes || []).join("\n")} placeholder="one pattern per line" onInput=${e => update({ excludes: e.target.value.split("\n") })} />
      </div>
      <div class="settings-addon-actions"><button data-settings-button="primary" disabled=${configBusy || busy} onClick=${saveConfig}>${configBusy ? "Saving…" : "Save configuration"}</button></div>
    </section>

    <section class="restic-section">
      <h4>Status</h4>
      <div class="restic-actions"><button type="button" disabled=${busy} onClick=${refreshStatus}>Refresh status</button><span class="settings-addon-help">No hidden polling; status refresh is explicit.</span></div>
      <div class="restic-status-line">
        <span class="restic-pill">${running ? "running" : "idle"}</span>
        <span class="restic-muted">Last attempt: ${formatDate(status?.lastAttempt)}</span>
        <span class="restic-muted">Last success: ${formatDate(status?.lastSuccess)}</span>
        <span class="restic-muted">Next run: ${formatDate(status?.nextRun)}</span>
      </div>
      <div class="restic-compact-grid">
        <${StatusCard} title="Backup" value=${status?.backup} />
        <${StatusCard} title="Maintenance" value=${status?.maintenance} />
        <${StatusCard} title="Last operation" value=${status?.operation} />
      </div>
      ${logs && html`<details open><summary>Redacted logs</summary><pre class="restic-log">${redactText(logs)}</pre></details>`}
    </section>

    <section class="restic-section">
      <h4>Actions</h4>
      <div class="restic-actions">
        <button type="button" disabled=${busy} onClick=${() => runAction({ action: "test" })}>Test connection</button>
        <button type="button" disabled=${busy} onClick=${() => runAction({ action: "backup" })}>Back up now</button>
        <button type="button" disabled=${busy} onClick=${() => runAction({ action: "snapshots" })}>List snapshots</button>
        <button type="button" disabled=${busy} onClick=${() => runAction({ action: "check" })}>Check metadata</button>
        <button type="button" disabled=${busy} onClick=${() => runAction({ action: "previewRetention" })}>Preview retention</button>
        <button type="button" disabled=${busy} onClick=${() => runAction({ action: "cancel" })}>Cancel</button>
        ${destructive("Init repository", INIT_CONFIRMATION, { action: "init" })}
        ${destructive("Apply retention", RETENTION_CONFIRMATION, { action: "applyRetention", token: preview.token, ids: preview.ids }, Boolean(preview.token && preview.ids.length))}
      </div>
      <div class="restic-compact-grid">
        <div class="settings-addon-field">
          <label class="settings-addon-label" for="restic-restore-snapshot">Restore snapshot</label>
          <select id="restic-restore-snapshot" class="settings-addon-control" value=${selectedSnapshot} onChange=${e => setRestoreSnapshot(e.target.value)}>
            <option value="">Select snapshot…</option>
            ${snapshots.map(s => html`<option value=${snapshotId(s)}>${snapshotId(s)} ${s.time ? `· ${formatDate(s.time)}` : ""}</option>`)}
          </select>
        </div>
        <div class="settings-addon-field">
          <label class="settings-addon-label" for="restic-restore-target">Restore target (empty absolute directory)</label>
          <input id="restic-restore-target" class="settings-addon-control restic-mono" type="text" value=${restoreTarget} placeholder="/tmp/restic-restore" onInput=${e => setRestoreTarget(e.target.value)} />
        </div>
      </div>
      <div class="restic-actions">${destructive("Restore", RESTORE_CONFIRMATION, { action: "restore", snapshot: selectedSnapshot, target: restoreTarget }, Boolean(selectedSnapshot && restoreTarget.startsWith("/")))}</div>
      ${preview.token && html`<p class="settings-addon-status" role="status">Retention preview token ready for ${preview.ids.length} snapshot ID(s).</p>`}
      ${snapshots.length > 0 && html`<div class="restic-snapshot-list">${snapshots.map(s => html`<div class="restic-snapshot"><strong>${snapshotId(s)}</strong><span class="restic-muted">${s.time ? formatDate(s.time) : "time unknown"}${s.hostname ? ` · ${s.hostname}` : ""}</span>${s.paths && html`<div class="restic-muted">${Array.isArray(s.paths) ? s.paths.join(", ") : String(s.paths)}</div>`}</div>`)}</div>`}
    </section>

    <section class="restic-section">
      <h4>Paths and migration</h4>
      <div class="restic-compact-grid">
        <div class="restic-card"><h5>Sources</h5>${paths?.sources?.length ? paths.sources.map(source => html`<p><strong>${source.name}</strong><br/><code>${source.path}</code></p>`) : html`<p class="settings-addon-help">No sources reported.</p>`}</div>
        <div class="restic-card"><h5>Runtime paths</h5><p><span class="restic-muted">State:</span> <code>${paths?.stateDir || "unknown"}</code></p><p><span class="restic-muted">Stage:</span> <code>${paths?.stageDir || "unknown"}</code></p></div>
      </div>
      ${migration && html`<details><summary>Migration details</summary><pre class="restic-json">${jsonText(migration)}</pre></details>`}
      ${receipt && html`<details open><summary>Last action receipt</summary><pre class="restic-json">${jsonText(receipt)}</pre></details>`}
    </section>

    ${message && html`<p class="settings-addon-status" role="status">${message}</p>`}
    ${error && html`<p class="settings-addon-error" role="alert">${redactText(error)}</p>`}
  </div>`;
}

try {
  if (HAS_RUNTIME) {
    const registry = globalThis.__piclawSettingsPaneRegistry;
    const register = registry?.registerSettingsPane || globalThis.__piclaw_web?.registerSettingsPane;
    register?.({ id: ADDON_ID, label: "Restic Backup", icon: ICON, component: ResticSettings, order: 195 });
    registry?.notifySettingsPanesChanged?.();
    if (!registry?.notifySettingsPanesChanged && register) globalThis.dispatchEvent?.(new CustomEvent("piclaw:settings-panes-changed"));
  }
} catch {}
