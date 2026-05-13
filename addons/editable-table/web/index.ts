// @ts-nocheck
import { parseMarkdownTable, serializeMarkdownTable, trimEmptyTrailingRows } from "../shared.ts";

const WIDGET_EVENT = "piclaw-extension-ui:widget";
const PANEL_ID = "piclaw-editable-table-panel";
const STYLE_ID = "piclaw-editable-table-style";

function ensureStyles() {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
#${PANEL_ID}{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;padding:24px;background:color-mix(in srgb,var(--bg-primary,#0b1220) 62%, transparent);backdrop-filter:blur(10px)}
#${PANEL_ID}[hidden]{display:none}
#${PANEL_ID} .et-shell{width:min(1120px,calc(100vw - 32px));height:min(760px,calc(100vh - 32px));display:flex;flex-direction:column;overflow:hidden;background:var(--bg-secondary,#111827);color:var(--text-primary,#e5e7eb);border:1px solid var(--border-color,rgba(148,163,184,.18));border-radius:18px;box-shadow:0 24px 80px rgba(0,0,0,.35)}
#${PANEL_ID} .et-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:18px 20px 14px;border-bottom:1px solid var(--border-color,rgba(148,163,184,.18));background:color-mix(in srgb,var(--bg-secondary,#111827) 88%, var(--accent-color,#3b82f6) 12%)}
#${PANEL_ID} .et-title{font-size:1.05rem;font-weight:700;letter-spacing:-.02em}
#${PANEL_ID} .et-sub{margin-top:6px;font-size:.88rem;line-height:1.45;color:var(--text-secondary,#94a3b8);max-width:70ch}
#${PANEL_ID} .et-close,#${PANEL_ID} .et-action,#${PANEL_ID} .et-secondary{appearance:none;border:1px solid var(--border-color,rgba(148,163,184,.18));background:var(--bg-tertiary,var(--bg-primary,#0f172a));color:var(--text-primary,#e5e7eb);border-radius:10px;padding:9px 12px;font-size:.86rem;font-weight:600;cursor:pointer;transition:background .12s ease,border-color .12s ease,transform .12s ease}
#${PANEL_ID} .et-action{background:var(--accent-color,#3b82f6);border-color:var(--accent-color,#3b82f6);color:#fff}
#${PANEL_ID} .et-close:hover,#${PANEL_ID} .et-action:hover,#${PANEL_ID} .et-secondary:hover{transform:translateY(-1px)}
#${PANEL_ID} .et-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 20px;border-bottom:1px solid var(--border-color,rgba(148,163,184,.18));background:var(--bg-primary,#0f172a)}
#${PANEL_ID} .et-chip{font-size:.75rem;padding:4px 8px;border-radius:999px;background:color-mix(in srgb,var(--accent-color,#3b82f6) 16%, transparent);color:var(--text-secondary,#cbd5e1)}
#${PANEL_ID} .et-grid-wrap{flex:1;overflow:auto;background:var(--bg-primary,#0b1220)}
#${PANEL_ID} table{width:max-content;min-width:100%;border-collapse:separate;border-spacing:0}
#${PANEL_ID} th,#${PANEL_ID} td{border-right:1px solid var(--border-color,rgba(148,163,184,.18));border-bottom:1px solid var(--border-color,rgba(148,163,184,.18));min-width:140px;max-width:320px;padding:0;vertical-align:top;background:var(--bg-secondary,#111827)}
#${PANEL_ID} th:first-child,#${PANEL_ID} td:first-child{border-left:1px solid var(--border-color,rgba(148,163,184,.18))}
#${PANEL_ID} tr:first-child th{border-top:1px solid var(--border-color,rgba(148,163,184,.18))}
#${PANEL_ID} .et-corner{position:sticky;left:0;top:0;z-index:4;min-width:54px;width:54px;background:var(--bg-primary,#0f172a)}
#${PANEL_ID} .et-row-head{position:sticky;left:0;z-index:3;min-width:54px;width:54px;text-align:center;font-size:.78rem;font-weight:700;color:var(--text-secondary,#94a3b8);background:var(--bg-primary,#0f172a)}
#${PANEL_ID} .et-head{position:sticky;top:0;z-index:2;background:var(--bg-primary,#0f172a)}
#${PANEL_ID} .et-cell{display:block;min-height:42px;padding:10px 12px;outline:none;white-space:pre-wrap;line-height:1.4;color:var(--text-primary,#e5e7eb);cursor:text;user-select:text;-webkit-user-select:text;overflow-wrap:anywhere}
#${PANEL_ID} .et-head .et-cell{font-weight:700}
#${PANEL_ID} .et-cell:focus{background:color-mix(in srgb,var(--accent-color,#3b82f6) 10%, var(--bg-secondary,#111827));box-shadow:inset 0 0 0 2px color-mix(in srgb,var(--accent-color,#3b82f6) 72%, transparent)}
#${PANEL_ID} .et-footer{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 20px;border-top:1px solid var(--border-color,rgba(148,163,184,.18));background:var(--bg-secondary,#111827)}
#${PANEL_ID} .et-status{font-size:.82rem;color:var(--text-secondary,#94a3b8)}
@media (max-width: 900px){#${PANEL_ID}{padding:12px}#${PANEL_ID} .et-shell{width:calc(100vw - 12px);height:calc(100vh - 12px)}}
`;
  document.head.appendChild(style);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function editableCellHtml(value, label) {
  return `<div class="et-cell" role="textbox" aria-label="${escapeHtml(label)}" contenteditable="true" spellcheck="false" inputmode="text" enterkeyhint="next">${escapeHtml(value)}</div>`;
}

function insertPlainTextAtSelection(text) {
  const selection = window.getSelection?.();
  if (!selection || selection.rangeCount === 0) {
    document.execCommand?.("insertText", false, text);
    return;
  }
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(String(text || ""));
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function ensurePanel() {
  ensureStyles();
  let root = document.getElementById(PANEL_ID);
  if (root) return root;
  root = document.createElement("div");
  root.id = PANEL_ID;
  root.hidden = true;
  root.innerHTML = `
    <div class="et-shell" role="dialog" aria-modal="true" aria-label="Editable table widget">
      <div class="et-header">
        <div>
          <div class="et-title">Edit table</div>
          <div class="et-sub">Edit the table, then insert the Markdown table back into chat.</div>
        </div>
        <button type="button" class="et-close">Close</button>
      </div>
      <div class="et-toolbar">
        <button type="button" class="et-secondary" data-action="add-row">+ Row</button>
        <button type="button" class="et-secondary" data-action="add-col">+ Column</button>
        <button type="button" class="et-secondary" data-action="trim">Trim empty rows</button>
        <span class="et-chip" data-role="summary"></span>
      </div>
      <div class="et-grid-wrap"><table><thead></thead><tbody></tbody></table></div>
      <div class="et-footer">
        <div class="et-status">Markdown out, spreadsheet-style editing in.</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
          <button type="button" class="et-secondary" data-action="copy">Copy Markdown</button>
          <button type="button" class="et-action" data-action="submit">Insert into chat</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(root);
  return root;
}

function readCellValue(cell) {
  return String(cell?.textContent || "").replace(/\u00a0/g, " ").trimEnd();
}

function collectTableState(root) {
  const headers = Array.from(root.querySelectorAll("thead .et-cell")).map(readCellValue);
  const rows = Array.from(root.querySelectorAll("tbody tr")).map((tr) => Array.from(tr.querySelectorAll("td .et-cell")).map(readCellValue));
  return { headers, rows: trimEmptyTrailingRows(rows) };
}

function focusCell(root, rowIndex, colIndex) {
  const selector = rowIndex < 0
    ? `thead th[data-col="${colIndex}"] .et-cell`
    : `tbody tr[data-row="${rowIndex}"] td[data-col="${colIndex}"] .et-cell`;
  const cell = root.querySelector(selector);
  if (!cell) return;
  cell.focus();
  const range = document.createRange();
  range.selectNodeContents(cell);
  range.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

function renderTable(root, state) {
  const thead = root.querySelector("thead");
  const tbody = root.querySelector("tbody");
  const summary = root.querySelector('[data-role="summary"]');
  const width = Math.max(1, state.headers.length, ...state.rows.map((row) => row.length));
  while (state.headers.length < width) state.headers.push(`Column ${state.headers.length + 1}`);
  state.rows = state.rows.map((row) => Array.from({ length: width }, (_unused, index) => row[index] ?? ""));

  thead.innerHTML = `<tr><th class="et-corner"></th>${state.headers.map((header, index) => `<th class="et-head" data-col="${index}">${editableCellHtml(header, `Column header ${index + 1}`)}</th>`).join("")}</tr>`;
  tbody.innerHTML = state.rows.map((row, rowIndex) => `<tr data-row="${rowIndex}"><th class="et-row-head">${rowIndex + 1}</th>${row.map((cell, colIndex) => `<td data-col="${colIndex}">${editableCellHtml(cell, `Row ${rowIndex + 1}, column ${colIndex + 1}`)}</td>`).join("")}</tr>`).join("");
  summary.textContent = `${state.rows.length} row${state.rows.length === 1 ? "" : "s"} · ${width} column${width === 1 ? "" : "s"}`;
}

async function submitMarkdown(chatJid, markdown) {
  const response = await fetch(`/agent/default/message?chat_jid=${encodeURIComponent(chatJid)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: markdown, mode: "auto", media_ids: [] }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw new Error(payload?.error || `HTTP ${response.status}`);
  }
  return response.json().catch(() => ({}));
}

function installEditableTableBridge() {
  if (typeof window === "undefined" || window.__piclawEditableTableBridgeInstalled) return;
  window.__piclawEditableTableBridgeInstalled = true;

  window.addEventListener(WIDGET_EVENT, async (event) => {
    const payload = event?.detail?.payload;
    if (payload?.key && !String(payload.key).startsWith("editable-table:")) return;
    if (payload?.options?.extension !== "editable-table") return;

    const root = ensurePanel();
    const shell = root.querySelector(".et-shell");
    const closeBtn = root.querySelector(".et-close");
    const titleEl = root.querySelector(".et-title");
    const subEl = root.querySelector(".et-sub");
    const grid = root.querySelector("table");
    const contentMarkdown = Array.isArray(payload?.content) ? String(payload.content[0] || "") : "";
    const sourceMarkdown = String(payload?.options?.markdown_table || contentMarkdown || "");
    const chatJid = String(payload?.chat_jid || "web:default");

    let table;
    try {
      table = parseMarkdownTable(sourceMarkdown);
    } catch (error) {
      console.warn("[editable-table] Invalid markdown table payload", error);
      return;
    }

    const state = {
      headers: [...table.headers],
      rows: table.rows.map((row) => [...row]),
      chatJid,
    };

    titleEl.textContent = String(payload?.options?.title || "Edit table");
    subEl.textContent = String(payload?.options?.instructions || "Edit the table, then click Insert into chat to send the Markdown table back into the conversation.");
    renderTable(root, state);
    root.hidden = false;
    document.body.style.overflow = "hidden";

    const syncStateFromDom = () => {
      const snapshot = collectTableState(root);
      state.headers = snapshot.headers;
      state.rows = snapshot.rows;
    };

    const handleClose = () => {
      root.hidden = true;
      document.body.style.overflow = "";
    };

    closeBtn.onclick = handleClose;
    root.onclick = (e) => {
      if (e.target === root) handleClose();
    };

    root.onkeydown = async (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleClose();
        return;
      }
      const cell = e.target?.closest?.(".et-cell");
      if (!cell) return;
      const th = cell.closest("th");
      const td = cell.closest("td");
      const colIndex = Number((th || td)?.dataset?.col || 0);
      const rowEl = td?.closest?.("tr");
      const rowIndex = rowEl ? Number(rowEl.dataset.row || 0) : -1;

      if (e.key === "Tab") {
        e.preventDefault();
        syncStateFromDom();
        if (e.shiftKey) {
          if (colIndex > 0) focusCell(root, rowIndex, colIndex - 1);
          else if (rowIndex > 0) focusCell(root, rowIndex - 1, state.headers.length - 1);
          else focusCell(root, rowIndex, 0);
        } else {
          if (colIndex + 1 < state.headers.length) focusCell(root, rowIndex, colIndex + 1);
          else if (rowIndex + 1 < state.rows.length) focusCell(root, rowIndex + 1, 0);
          else focusCell(root, rowIndex, colIndex);
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        syncStateFromDom();
        focusCell(root, rowIndex + 1 < state.rows.length ? rowIndex + 1 : rowIndex, colIndex);
      }
    };

    root.oninput = (e) => {
      if (!e.target?.closest?.(".et-cell")) return;
      syncStateFromDom();
      const summary = root.querySelector('[data-role="summary"]');
      summary.textContent = `${state.rows.length} row${state.rows.length === 1 ? "" : "s"} · ${state.headers.length} column${state.headers.length === 1 ? "" : "s"}`;
    };

    root.onpaste = (e) => {
      const cell = e.target?.closest?.(".et-cell");
      if (!cell) return;
      const text = e.clipboardData?.getData("text/plain") || "";
      const td = cell.closest?.("td");
      if (!td || !/[\t\n]/.test(text)) {
        e.preventDefault();
        insertPlainTextAtSelection(text);
        queueMicrotask(syncStateFromDom);
        return;
      }
      e.preventDefault();
      syncStateFromDom();
      const startRow = Number(td.closest("tr")?.dataset?.row || 0);
      const startCol = Number(td.dataset.col || 0);
      const matrix = text.split(/\r?\n/).filter(Boolean).map((line) => line.split("\t"));
      if (matrix.length === 0) {
        insertPlainTextAtSelection(text);
        queueMicrotask(syncStateFromDom);
        return;
      }
      const neededCols = startCol + Math.max(...matrix.map((row) => row.length));
      while (state.headers.length < neededCols) state.headers.push(`Column ${state.headers.length + 1}`);
      while (state.rows.length < startRow + matrix.length) state.rows.push(Array.from({ length: state.headers.length }, () => ""));
      state.rows = state.rows.map((row) => Array.from({ length: state.headers.length }, (_unused, index) => row[index] ?? ""));
      matrix.forEach((row, rowOffset) => {
        row.forEach((value, colOffset) => {
          state.rows[startRow + rowOffset][startCol + colOffset] = value;
        });
      });
      renderTable(root, state);
      focusCell(root, startRow, startCol);
    };

    root.querySelector('[data-action="add-row"]').onclick = () => {
      syncStateFromDom();
      state.rows.push(Array.from({ length: state.headers.length }, () => ""));
      renderTable(root, state);
      focusCell(root, state.rows.length - 1, 0);
    };

    root.querySelector('[data-action="add-col"]').onclick = () => {
      syncStateFromDom();
      state.headers.push(`Column ${state.headers.length + 1}`);
      state.rows = state.rows.map((row) => [...row, ""]);
      renderTable(root, state);
      focusCell(root, -1, state.headers.length - 1);
    };

    root.querySelector('[data-action="trim"]').onclick = () => {
      syncStateFromDom();
      state.rows = trimEmptyTrailingRows(state.rows);
      renderTable(root, state);
    };

    root.querySelector('[data-action="copy"]').onclick = async () => {
      syncStateFromDom();
      const markdown = serializeMarkdownTable({ headers: state.headers, rows: state.rows });
      await navigator.clipboard?.writeText?.(markdown).catch(() => undefined);
    };

    root.querySelector('[data-action="submit"]').onclick = async () => {
      syncStateFromDom();
      const markdown = serializeMarkdownTable({ headers: state.headers, rows: state.rows });
      const status = root.querySelector('.et-status');
      status.textContent = 'Inserting edited Markdown table into chat…';
      try {
        await submitMarkdown(state.chatJid, markdown);
        status.textContent = 'Inserted Markdown table into chat.';
        handleClose();
      } catch (error) {
        console.error('[editable-table] submit failed', error);
        status.textContent = error?.message || 'Failed to insert Markdown table into chat.';
      }
    };

    queueMicrotask(() => focusCell(root, table.rows.length > 0 ? 0 : -1, 0));
  });
}

try {
  installEditableTableBridge();
} catch {}
