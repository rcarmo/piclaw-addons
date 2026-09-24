import { action, requestId, escapeText as e } from "./api.ts";
const X =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8"/></svg>';
const pathPrefix = "piclaw://addon/code-review/";
type DraftState = {
  body: string;
  threadId?: string;
  fileId: string;
  range?: { startLine: number; endLine: number };
  side: string;
  draftId?: string;
  version?: number;
  requestId: string;
  pending?: { body: string; requestId: string; expectedVersion?: number };
};
type PendingReply = {
  requestId: string;
  threadId: string;
  draftId?: string;
  draftVersion?: number;
};
const button = (name: string, label: string, title: string, extra = "") =>
  `<button type="button" data-action="${name}" title="${e(title)}" ${extra}>${label}</button>`;
/** One real pane. All mutations use authenticated APIs; no model runs are triggered by mounting. */
export class CodeReviewPane {
  private element: HTMLElement;
  private abort = new AbortController();
  private disposed = false;
  private dirtyCallback: ((value: boolean) => void) | null = null;
  private dirty = false;
  private reviewId: string;
  private review: any;
  private snapshots: any[] = [];
  private snapshotId = "";
  private files: any[] = [];
  private fileId = "";
  private content: any;
  private targets: any[] = [];
  private threads: any[] = [];
  private selected = new Set<string>();
  private detail = new Map<string, any>();
  private projections = new Map<string, any>();
  private fileScroll = new Map<string, number>();
  private selection: {
    startLine: number;
    endLine: number;
    side: string;
  } | null = null;
  private composer: DraftState | null = null;
  private pendingReply: PendingReply | null = null;
  private replyStorageAvailable = true;
  private externallyReconciledThreads = new Set<string>();
  private storageListener = (event: StorageEvent) => {
    if (event.key !== this.replyKey() || this.disposed) return;
    if (event.newValue === null && this.pendingReply && event.oldValue) {
      try {
        const previous = JSON.parse(event.oldValue);
        if (previous.requestId === this.pendingReply.requestId)
          this.externallyReconciledThreads.add(this.pendingReply.threadId);
      } catch { /* A malformed marker grants no authority. */ }
    }
    this.pendingReply = this.readPendingReply();
    this.render();
  };
  private draftTimer: ReturnType<typeof setTimeout> | undefined;
  private savedDrafts: any[] = [];
  private savingDraft = false;
  private draftPromise: Promise<void> | null = null;
  private editMessage: any = null;
  private draftEpoch = 0;
  private busy = false;
  private pendingPayload: Record<string, unknown> | null = null;
  private sendPreview: {
    items: Array<{
      threadId: string;
      version: number;
      assignmentEpoch: number;
      anchor: { snapshotFileId: string };
    }>;
  } | null = null;
  private commentThreadVersion: number | undefined;
  private view: "source" | "unified" | "split" = "source";
  private wrap = false;
  private showFiles = false;
  private drawer: "threads" | "send" | null = null;
  private sendIntent: string | null = null;
  private summary = "";
  private activeTarget: any = null;
  private status = "";
  private fileFilter = "";
  private threadFilter = "all";
  private page = 0;
  private loadEpoch = 0;
  private filesEpoch = 0;
  private loading = false;
  private observer: ResizeObserver;
  private moreMenu = false;
  private loadError = "";
  private receipts: any[] | null = null;
  private fileDrafts = new Map<string, DraftState>();
  private sourceSelection = new Map<
    string,
    { startLine: number; endLine: number; side: string }
  >();
  private drawerFocus: HTMLElement | null = null;
  private threadPageAfter = "";
  private hasMoreThreads = false;
  private moreMessages = new Map<string, boolean>();
  private contextExpanded = false;
  private selectedThreadReads = new Map<string, any>();
  constructor(container: HTMLElement, context: any) {
    this.reviewId = String(context.path || "").slice(pathPrefix.length);
    if (!/^[\w-]+$/.test(this.reviewId)) throw Error("Invalid review path.");
    this.pendingReply = this.readPendingReply();
    this.element = container.ownerDocument.createElement("section");
    this.element.className = "cr-pane";
    this.element.dataset.skin = [
      ...container.ownerDocument.querySelectorAll<HTMLLinkElement>(
        "link[href]",
      ),
    ].some((link) => link.href.includes("/static/classic/"))
      ? "classic"
      : "visual";
    this.element.setAttribute("aria-label", "Code Review");
    container.append(this.element);
    this.element.addEventListener("click", this.click);
    this.element.addEventListener("change", this.change);
    this.element.addEventListener("input", this.input);
    this.element.addEventListener("keydown", this.keydown);
    this.element.addEventListener("copy", this.copySource);
    this.element.ownerDocument.defaultView?.addEventListener("storage", this.storageListener);
    this.observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 1200;
      this.element.dataset.narrow = String(width < 720);
      this.element.dataset.medium = String(width < 1100);
      if (width < 1100 && this.view === "split") {
        this.view = "unified";
        this.render();
      }
    });
    this.observer.observe(this.element);
    this.render();
    void this.load();
  }
  getContent() {
    return undefined;
  }
  isDirty() {
    return this.dirty;
  }
  onDirtyChange(callback: (value: boolean) => void) {
    this.dirtyCallback = callback;
  }
  focus() {
    if (!this.review) void this.load();
    else this.element.querySelector<HTMLElement>("button,select")?.focus();
  }
  resize() {}
  exportHostTransferState() {
    return {
      reviewId: this.reviewId,
      fileId: this.fileId,
      snapshotId: this.snapshotId,
      view: this.view,
      scroll: this.element.querySelector(".cr-source")?.scrollTop || 0,
    };
  }
  async beforeDetachFromHost() {
    await this.persistDraft();
    if (this.dirty)
      throw Error(
        "Save or explicitly discard the comment draft before detaching.",
      );
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    clearTimeout(this.draftTimer);
    this.observer.disconnect();
    this.element.ownerDocument.defaultView?.removeEventListener("storage", this.storageListener);
    this.element.remove();
  }
  private setDirty(value: boolean) {
    this.dirty = value;
    this.dirtyCallback?.(value);
  }
  private replyKey() { return `piclaw.code-review.pending-reply.${this.reviewId}`; }
  private readPendingReply(): PendingReply | null {
    try {
      const stored = localStorage.getItem(this.replyKey());
      if (!stored) return null;
      const value = JSON.parse(stored);
      if (!value || typeof value.requestId !== "string" || !/^[\w-]{1,256}$/.test(value.requestId)
          || typeof value.threadId !== "string" || !/^thread_[\w-]{1,256}$/.test(value.threadId))
        throw Error("Invalid pending reply marker.");
      return { requestId: value.requestId, threadId: value.threadId,
        ...(typeof value.draftId === "string" ? { draftId: value.draftId } : {}),
        ...(Number.isSafeInteger(value.draftVersion) ? { draftVersion: value.draftVersion } : {}) };
    } catch {
      this.replyStorageAvailable = false;
      this.status = "Pending reply marker is unreadable. Clear browser site data or restore it before sending another reply.";
      return null;
    }
  }
  private savePendingReply(value: PendingReply) {
    if (!this.replyStorageAvailable)
      throw Error("Browser recovery storage is unavailable; do not send a reply with an untracked acknowledgement.");
    const existing = this.readPendingReply() ?? this.pendingReply;
    if (existing && existing.requestId !== value.requestId)
      throw Error("Reconcile or dismiss the earlier reply before posting another.");
    // Only correlation IDs: this marker is shared by same-origin tabs, never source or reply text.
    try { localStorage.setItem(this.replyKey(), JSON.stringify(value)); }
    catch {
      this.replyStorageAvailable = false;
      throw Error("Browser recovery storage is unavailable; reply was not sent.");
    }
    this.pendingReply = value;
  }
  private clearPendingReply(requestId: string) {
    if (this.readPendingReply()?.requestId === requestId)
      localStorage.removeItem(this.replyKey());
    if (this.pendingReply?.requestId === requestId) this.pendingReply = null;
  }
  private async reconcileReply(pending: PendingReply): Promise<boolean> {
    const receipt = await this.api<{ committed: boolean; messageId?: string }>("replyReceipt", {
      requestId: pending.requestId, threadId: pending.threadId,
    });
    if (!receipt.committed) {
      this.status = "No committed reply found. Keep the saved draft and retry it explicitly if needed.";
      return false;
    }
    this.status = "";
    await this.reloadThreads();
    if (pending.draftId && pending.draftVersion !== undefined)
      try {
        await this.api("deleteDraft", {
          draftId: pending.draftId, expectedVersion: pending.draftVersion, requestId: requestId(),
        });
        this.savedDrafts = await this.api("drafts");
      } catch {
        this.status = "Reply committed. The saved draft changed or could not be removed; inspect it before deleting.";
      }
    if (!this.status) this.status = "Reply committed. No work was queued or replayed.";
    if (this.composer?.requestId === pending.requestId) {
      clearTimeout(this.draftTimer);
      this.fileDrafts.delete(this.composer.fileId);
      this.draftEpoch++;
      this.composer = null;
      this.editMessage = null;
      this.setDirty(false);
    }
    this.clearPendingReply(pending.requestId);
    return true;
  }
  private async api<T = any>(
    name: string,
    payload: Record<string, unknown> = {},
  ) {
    return action<T>(
      name,
      { reviewId: this.reviewId, ...payload },
      this.abort.signal,
    );
  }
  private fail(error: unknown) {
    if (this.disposed || (error as Error)?.name === "AbortError") return;
    this.status = (error as Error)?.message || "Review action failed.";
    this.render();
  }
  private async load() {
    if (this.disposed) return;
    this.loading = true;
    this.pendingReply = this.readPendingReply();
    try {
      [
        this.review,
        this.targets,
        this.snapshots,
        this.threads,
        this.savedDrafts,
      ] = await Promise.all([
        this.api("review"),
        this.api("targets"),
        this.api("snapshots"),
        this.api("threads"),
        this.api("drafts"),
      ]);
      const target = JSON.parse(this.review.target_json);
      this.activeTarget ??= target;
      this.hasMoreThreads = this.threads.length === 50;
      this.threadPageAfter = this.threads.at(-1)?.id || "";
      this.snapshotId ||= this.snapshots[0]?.id || "";
      this.loadError = "";
      await this.loadFiles();
    } catch (error) {
      this.loadError = (error as Error).message;
      this.fail(error);
    } finally {
      this.loading = false;
      this.render();
    }
  }
  private async loadFiles() {
    const epoch = ++this.filesEpoch;
    // Invalidate any older file/projection request as soon as the snapshot changes.
    ++this.loadEpoch;
    const snapshotId = this.snapshotId;
    if (!snapshotId) return;
    const files = await this.api<any[]>("files", { snapshotId });
    if (epoch !== this.filesEpoch || snapshotId !== this.snapshotId || this.disposed) return;
    this.files = files;
    if (!files.some((f) => f.id === this.fileId))
      this.fileId = files[0]?.id || "";
    this.page = 0;
    await this.loadContent();
  }
  private async loadContent() {
    const epoch = ++this.loadEpoch;
    if (!this.fileId) {
      this.content = null;
      return;
    }
    const fileId = this.fileId;
    const response = await this.api("file", {
      fileId,
      offset: this.page * 300,
      limit: 300,
    });
    if (epoch !== this.loadEpoch || this.disposed) return;
    this.content = response;
    this.view =
      response.change_kind === "source"
        ? "source"
        : this.view === "source"
          ? "unified"
          : this.view;
    this.projections.clear();
    for (const thread of this.threads) {
      try {
        const projection = await this.api("projection", {
          threadId: thread.id,
          fileId,
        });
        if (epoch !== this.loadEpoch) return;
        this.projections.set(thread.id, projection);
      } catch {
        /* Other-file or unavailable projection stays out of this view. */
      }
    }
    this.render();
  }
  private async reloadThreads() {
    this.threads = await this.api("threads");
    this.hasMoreThreads = this.threads.length === 50;
    this.threadPageAfter = this.threads.at(-1)?.id || "";
    for (const thread of this.threads) {
      if (this.detail.has(thread.id)) {
        const data = await this.api("thread", { threadId: thread.id });
        this.detail.set(thread.id, data);
        this.moreMessages.set(thread.id, data.messages.length === 100);
        this.selectedThreadReads.set(thread.id, data);
      }
    }
    for (const id of this.selected)
      if (!this.threads.some((t) => t.id === id && t.state === "open"))
        this.selected.delete(id);
    await this.loadContent();
  }
  private async openThread(threadId: string) {
    const data = await this.api("thread", { threadId });
    this.detail.set(threadId, data);
    this.moreMessages.set(threadId, data.messages.length === 100);
    this.selectedThreadReads.set(threadId, data);
    this.render();
  }
  private relevant(thread: any) {
    const anchor = thread.anchor;
    const p = this.projections.get(thread.id);
    return (
      anchor.snapshotFileId === this.fileId ||
      p?.status === "exact" ||
      p?.status === "moved"
    );
  }
  private threadRows() {
    return this.threads.filter(
      (t) => this.relevant(t) && t.state !== "deleted",
    );
  }
  private hasTargetMismatch() {
    return [...this.selected].some((id) => {
      const thread = this.threads.find((t) => t.id === id);
      return !thread || thread.target.chatId !== this.activeTarget?.chatId ||
        thread.target.incarnation !== this.activeTarget?.incarnation;
    });
  }
  private threadHtml(thread: any) {
    const data = this.detail.get(thread.id),
      anchor = thread.anchor,
      p = this.projections.get(thread.id);
    const first =
      data?.messages?.find((m: any) => m.body)?.body || "Open discussion";
    const location =
      anchor.scope === "file"
        ? "Whole file"
        : `${p?.side || anchor.side} lines ${p?.startLine ?? anchor.startLine}–${p?.endLine ?? anchor.endLine}`;
    return `<article class="cr-thread" id="cr-${thread.id}"><header><label title="Select this concern for a later explicit send. Does not send or resolve it."><input type="checkbox" data-pick="${thread.id}" ${this.selected.has(thread.id) ? "checked" : ""} ${thread.state !== "open" ? "disabled" : ""} title="Include this thread in the next review sent to the agent.">Include in send</label><strong>${e(thread.state)}</strong><span class="cr-muted">${e(location)}${p?.status === "moved" ? " · moved since review" : ""}</span>${button("expand", "Discussion", data ? "Collapse this discussion." : "Load public messages and replies.", `data-thread="${thread.id}"`)}</header>${data ? `<div class="cr-messages">${data.messages.map((m: any) => `<div class="cr-message"><strong>${e(m.author_kind === "agent" ? "Agent" : "You")}</strong> <small>${e(m.updated_at)}${m.version > 1 ? " · edited" : ""}</small><div class="cr-message-body">${m.html ?? e(m.body ?? "Comment deleted")}</div>${m.author_kind === "operator" && !m.deleted ? button("edit", "Edit", "Edit your message; this does not send updated instructions.", `data-message="${m.id}" data-thread="${thread.id}"`) + button("delete-message", "Delete", "Delete this message body while retaining its replies.", `data-message="${m.id}" data-thread="${thread.id}" data-settings-button="danger"`) : ""}</div>`).join("")}</div>${this.moreMessages.get(thread.id) ? button("more-messages", "More replies", "Load the next bounded page of this thread.", `data-thread="${thread.id}"`) : ""}<footer>${button("reply", "Reply", thread.state === "resolved" ? "Reopen this thread before replying." : "Write a reply without starting agent work.", `data-thread="${thread.id}" ${thread.state === "resolved" ? "disabled" : ""}`)}${button(thread.state === "resolved" ? "reopen" : "resolve", thread.state === "resolved" ? "Reopen" : "Resolve", "Change concern state explicitly; queued work is not cancelled.", `data-thread="${thread.id}"`)}${button("send-thread", "Send thread", "Preview this concern before sending to its bound local agent.", `data-thread="${thread.id}" ${thread.state !== "open" ? "disabled" : ""}`)}${button("reassign", "Reassign", "Bind this thread explicitly to the selected toolbar target; old work is not cancelled.", `data-thread="${thread.id}"`)}${button("delete-thread", "Delete thread", "Confirm removing this discussion; already delivered work cannot be recalled.", `data-thread="${thread.id}" data-settings-button="danger"`)}</footer>` : `<div class="cr-message cr-muted">${e(first)}</div>`}</article>`;
  }
  private codeLine(
    side: string,
    line: number | null,
    kind: string,
    text: string,
  ) {
    if (line === null) return '<div class="cr-line cr-blank"></div>';
    const lines =
      side === "old" ? this.content.old.lines : this.content.new.lines;
    const token = lines.find((x: any) => x.number === line);
    const html = token?.text === text ? token.html : e(text);
    const sel =
      this.selection?.side === side &&
      line >= this.selection.startLine &&
      line <= this.selection.endLine;
    return `<div class="cr-line ${kind} ${sel ? "selected" : ""}" data-line="${line}" data-side="${side}"><button data-action="line-comment" data-side="${side}" data-line="${line}" title="Add guidance on ${side} line ${line}. No work starts until sent." aria-label="Comment on line ${line}" data-settings-button="unstyled">+</button><button data-action="select-line" data-line="${line}" data-side="${side}" title="Select this line; Shift-click or select another line to extend the range." data-settings-button="unstyled">${line}</button><span aria-hidden="true">${kind === "added" ? "+" : kind === "deleted" ? "−" : ""}</span><code>${html}</code></div>`;
  }
  private codeHtml() {
    if (!this.content)
      return '<p class="cr-empty">No source is available for this snapshot.</p>';
    const c = this.content,
      rows =
        c.diff ||
        c.new.lines.map((line: any) => ({
          kind: "context",
          oldLine: null,
          newLine: line.number,
          text: line.text,
        }));
    const mounted = new Set<string>();
    let html = "";
    if (!rows.length || (c.diff && rows.every((row: any) => row.kind === "context")))
      return '<p class="cr-empty">No changes in this comparison.</p>' +
        this.threadRows().filter((thread) => thread.anchor.scope === "file")
          .map((thread) => this.threadHtml(thread)).join("");
    const visible = new Set<number>();
    if (!this.contextExpanded && this.view !== "source") {
      rows.forEach((r: any, i: number) => {
        if (r.kind !== "context")
          for (
            let j = Math.max(0, i - 3);
            j <= Math.min(rows.length - 1, i + 3);
            j++
          )
            visible.add(j);
      });
      for (const t of this.threadRows()) {
        const p = this.projections.get(t.id),
          line = p?.endLine ?? t.anchor.endLine;
        const index = rows.findIndex(
          (r: any) => r.oldLine === line || r.newLine === line,
        );
        if (index >= 0)
          for (
            let j = Math.max(0, index - 2);
            j <= Math.min(rows.length - 1, index + 2);
            j++
          )
            visible.add(j);
      }
    }
    let skipped = 0;
    const flush = () => {
      if (skipped) {
        html += button(
          "expand-context",
          `Show ${skipped} unchanged lines`,
          "Expand bounded context from the current immutable snapshots.",
          'class="cr-expand" data-settings-button="unstyled"',
        );
        skipped = 0;
      }
    };
    for (const [index, row] of rows.entries()) {
      if (
        this.view !== "source" &&
        !this.contextExpanded &&
        !visible.has(index)
      ) {
        skipped++;
        continue;
      }
      flush();
      const side =
        this.view === "source"
          ? "source"
          : row.kind === "deleted"
            ? "old"
            : "new";
      if (this.view === "split")
        html += `<div class="cr-pair">${this.codeLine("old", row.oldLine, row.kind, row.text)}${this.codeLine("new", row.newLine, row.kind, row.text)}</div>`;
      else
        html += this.codeLine(
          side,
          row.kind === "deleted" ? row.oldLine : row.newLine,
          row.kind,
          row.text,
        );
      for (const thread of this.threadRows()) {
        if (mounted.has(thread.id)) continue;
        const anchor = thread.anchor,
          p = this.projections.get(thread.id),
          end = p?.endLine ?? anchor.endLine,
          ts = p?.side || anchor.side;
        if (
          anchor.scope === "range" &&
          end === (ts === "old" ? row.oldLine : row.newLine)
        ) {
          html += this.threadHtml(thread);
          mounted.add(thread.id);
        }
      }
    }
    flush();
    for (const thread of this.threadRows())
      if (!mounted.has(thread.id) && thread.anchor.scope === "file")
        html += this.threadHtml(thread);
    return html;
  }
  private render() {
    if (this.disposed) return;
    const active = this.element.ownerDocument.activeElement as HTMLInputElement;
    const focusId =
      active?.closest(".cr-pane") === this.element ? active.id : "";
    const selectionStart = active?.selectionStart,
      selectionEnd = active?.selectionEnd;
    const previousScroll =
      this.element.querySelector(".cr-source")?.scrollTop ||
      this.fileScroll.get(this.fileId) ||
      0;
    if (!this.review) {
      this.element.innerHTML = `<div class="cr-empty">${e(this.loadError || "Loading review…")}${this.loadError ? button("load", "Retry", "Retry loading this review without sending work.") : ""}</div>`;
      return;
    }
    const c = this.content,
      path = c?.new_path || c?.old_path || this.review.focus_path,
      snapshot = this.snapshots.find((s) => s.id === this.snapshotId);
    const fileRows = this.files.filter((f) =>
      (f.new_path || f.old_path || "")
        .toLowerCase()
        .includes(this.fileFilter.toLowerCase()),
    );
    this.element.innerHTML = `<div class="cr-toolbar">${button("files", "Files", "Show the files in this review.")}<select id="cr-snapshot" title="Choose an immutable saved-source or Git comparison snapshot.">${this.snapshots.map((s) => `<option value="${s.id}" ${s.id === this.snapshotId ? "selected" : ""} title="${e(s.mode + " captured " + s.captured_at)}">${e(s.mode + " · " + s.captured_at.slice(11, 19))}</option>`).join("")}</select><span class="cr-grow"></span><select id="cr-target" title="Choose a local target. Existing thread assignments require explicit reassignment.">${this.targets.map((t) => `<option value="${e(t.chatJid)}" ${t.chatJid === this.activeTarget?.chatId ? "selected" : ""}>${e(t.label)}</option>`).join("")}</select>${button("threads", `Threads (${this.threads.length})`, "Browse saved open, resolved and outdated concerns.")}${button("send", `Send to agent${this.selected.size ? " (" + this.selected.size + ")" : ""}`, this.selected.size ? "Preview selected guidance before queueing one review." : "Include at least one open thread to send.", `data-settings-button="primary" ${!this.selected.size ? "disabled" : ""}`)}<div class="cr-options">${button("options", "⋯", "View and capture options.", 'data-settings-button="icon" aria-label="View options"')}${this.moreMenu ? `<div class="cr-menu">${button("refresh", "Refresh saved source", "Capture the newest saved bytes; comments retain original anchors.")}${button("wrap", "Wrap long lines", "Toggle visual wrapping without changing saved source.")}${button("layout", this.view === "split" ? "Unified diff" : "Split diff", "Switch diff layout; unavailable in source mode.", this.view === "source" ? "disabled" : "")}${button("staged", "Staged changes", "Capture HEAD to index without staging or writing source.")}${button("unstaged", "Working changes", "Capture index to saved worktree, including untracked text files.")}${button("history", "Recent commits", "Select a bounded file-history commit to review.")}${button("add-file", "Add file", "Add another saved workspace file to this review explicitly.")}${button("drafts", `Drafts (${this.savedDrafts.length})`, "Restore an acknowledged private comment draft.")}${button("receipts", "Delivery receipts", "Inspect queued, failed and unknown attempts without resending.")}</div>` : ""}</div></div>
  ${
    this.receipts
      ? `<section class="cr-receipts" aria-label="Delivery receipts"><header><strong>Delivery receipts</strong>${button("close-receipts", X, "Close delivery receipts without changing queued work.", 'data-settings-button="icon" aria-label="Close receipts"')}</header>${this.receipts
          .map((d) => {
            const last = d.attempts.at(-1);
            return `<article><strong>${e(d.target.label)}</strong> <code>${e(d.id.slice(-8))}</code> <span>${e(last?.state || "unknown")}</span><small>${d.items.filter((i: any) => i.work_state === "completed").length}/${d.items.length} items completed</small>${last?.state === "rejected" ? button("retry", "Retry rejected send", "Create a numbered retry only after definite rejection.", `data-dispatch="${d.id}"`) : ""}${last?.state === "unknown" ? button("reconcile", "Reconcile outcome", "Inspect host evidence and explicitly record accepted or rejected; never blindly replay.", `data-dispatch="${d.id}"`) : ""}</article>`;
          })
          .join("")}</section>`
      : ""
  }
  ${this.status ? `<div class="cr-status" role="status">${e(this.status)}${button("dismiss", X, "Dismiss status.", 'data-settings-button="icon" aria-label="Dismiss status"')}</div>` : ""}
  ${this.pendingReply ? `<div class="cr-pending-reply" role="status">Reply acknowledgement uncertain. Check the saved receipt before sending another reply. ${button("reconcile-reply", "Reconcile reply", "Read the authorised reply receipt; never resend automatically.")}${button("dismiss-reply", "Dismiss", "Forget only this browser's pending reply marker; preserve saved drafts and replies.")}</div>` : ""}
  ${!this.replyStorageAvailable ? `<div class="cr-recovery-error" role="alert">Pending reply marker is unreadable. No reply was sent. ${button("clear-recovery", "Clear browser marker", "Forget only the unreadable local marker after confirming; saved drafts and published replies remain.")}</div>` : ""}
  <div class="cr-body"><nav class="cr-files ${this.showFiles ? "open" : ""}" ${this.files.length < 2 && !this.showFiles ? "hidden" : ""}><header>Files ${button("files", X, "Close the file list.", 'data-settings-button="icon" aria-label="Close file list"')}</header><input id="cr-filter" value="${e(this.fileFilter)}" placeholder="Filter paths" title="Filter paths in this snapshot without deleting anything.">${fileRows.map((f) => button("file", `<span>${e(f.new_path || f.old_path)}</span><small>${e(f.change_kind)}</small>`, "View this saved file without sending its comments.", `data-file="${f.id}" class="${f.id === this.fileId ? "active" : ""}" data-settings-button="unstyled"`)).join("")}</nav>
  <main class="cr-main"><header class="cr-file-header"><strong>${e(path)}</strong><span class="cr-grow cr-muted">${e(snapshot?.mode || "")} · ${e((c?.new_hash || c?.old_hash || "").slice(0, 10))} · ${e(c?.new?.language || "text")}${c?.new && !c.new.highlighted ? " (plain)" : ""}</span>${c?.currentSource && c.currentSource.status !== "unchanged" ? `<span class="cr-current-source" role="status" title="Saved review content remains unchanged; current source was checked separately.">Current saved file: ${e(c.currentSource.status)}</span>` : ""}${button("file-comment", "Comment on file", "Create guidance about the whole file without selecting lines.")}</header><div class="cr-source ${this.wrap ? "wrap" : ""}" tabindex="0">${this.codeHtml()}</div>
  <div class="cr-pagination">${button("previous", "Previous lines", "Load the previous bounded source/diff page.", this.page === 0 ? "disabled" : "")}<span>${this.page * 300 + 1}–${this.page * 300 + (c?.diff?.length ?? c?.new?.lines.length ?? 0)}</span>${button("next", "Next lines", "Load the next bounded source/diff page.", (this.page + 1) * 300 >= (c?.diffTotal || Math.max(c?.old.total || 0, c?.new.total || 0)) ? "disabled" : "")}</div>
  ${this.selection ? `<div class="cr-selection">${e(this.selection.side)} lines ${this.selection.startLine}–${this.selection.endLine}${button("range-comment", "Add comment", "Comment on the selected saved range.")}${button("clear-range", "Clear", "Clear selection only; comments remain.")}${button("reanchor", "Re-anchor thread", "Explicitly map a chosen thread to this selected range.")}</div>` : ""}
  ${this.composer ? `<section class="cr-composer"><strong>${this.editMessage ? "Edit message" : this.composer.threadId ? "Reply" : this.composer.range ? "Range comment" : "File comment"}</strong><textarea id="cr-body" title="Write public guidance; posting does not send it to an agent." placeholder="What should change or be checked?">${e(this.composer.body)}</textarea><footer><small>${this.dirty ? "Draft not yet saved" : "Draft saved"}</small><span class="cr-grow"></span>${button("cancel", "Cancel", "Discard this unpublished text with confirmation if needed.")}${button("post", this.editMessage ? "Save edit" : "Post comment", "Save guidance without queueing agent work.", 'data-settings-button="primary"')}</footer></section>` : ""}</main></div>
  ${
    this.drawer
      ? `<div class="cr-backdrop" data-action="close-drawer"></div><aside class="cr-drawer" role="dialog" aria-modal="true" aria-label="Review threads"><header><strong>${this.drawer === "send" ? "Send selected review" : "Threads"}</strong>${button("close-drawer", X, "Close without sending; keep the selection.", 'data-settings-button="icon" aria-label="Close review drawer"')}</header><select id="cr-thread-filter" title="Filter concerns without changing their state.">${["all", "open", "resolved", "outdated"].map((v) => `<option ${v === this.threadFilter ? "selected" : ""}>${v}</option>`).join("")}</select>${this.threads
          .filter(
            (t) =>
              this.threadFilter === "all" ||
              this.threadFilter === t.state ||
              (this.threadFilter === "outdated" && !this.relevant(t)),
          )
          .map(
            (t) =>
              `<div class="cr-drawer-item"><label><input type="checkbox" data-pick="${t.id}" ${this.selected.has(t.id) ? "checked" : ""} ${t.state === "resolved" ? "disabled" : ""} title="Include this concern in the next explicit send. Does not resolve it.">Include in send</label><strong>${e(t.state)}</strong><small>${e(t.id.slice(-8))} · ${e(t.anchor.side)} ${t.anchor.startLine ?? "file"}${this.projections.get(t.id)?.status === "missing" ? " · outdated (not mapped)" : this.projections.get(t.id)?.status === "ambiguous" ? " · ambiguous (not mapped)" : ""}</small>${button("jump", "Open discussion", "Reveal original source and public messages.", `data-thread="${t.id}"`)}</div>`,
          )
          .join(
            "",
          )}${this.hasMoreThreads ? button("more-threads", "More threads", "Load the next bounded page of review concerns.") : ""}${this.drawer === "send" ? `<section class="cr-send-preview" aria-label="Selected guidance and saved source versions">${this.sendPreview ? `<strong>Selected guidance (${this.sendPreview.items.length})</strong><ol>${this.sendPreview.items.map((item) => `<li data-preview-thread="${e(item.threadId)}"><code title="Selected thread ID">${e(item.threadId)}</code><small>Guidance v${e(item.version)} · assignment ${e(item.assignmentEpoch)}</small><small>Snapshot file <code title="Saved snapshot file ID">${e(item.anchor.snapshotFileId)}</code></small></li>`).join("")}</ol>` : `<p>Selection or target changed. Refresh the preview before queueing.</p>`}</section><textarea id="cr-summary" title="Optional overall instruction sent with selected thread references." placeholder="Overall guidance (optional)">${e(this.summary)}</textarea><p>Queue to ${e(this.activeTarget?.label)} behind current work. No interruption.</p>${button("refresh-send-preview", "Refresh preview", "Check current guidance versions and source snapshots without queueing work.")}${button("confirm-send", "Queue selected review", "Queue one review; replies and resolutions remain per thread.", `data-settings-button="primary" ${!this.sendPreview || !this.selected.size ? "disabled" : ""}`)}` : ""}</aside>`
      : ""
  }`;
    if (this.drawer === "send" && this.hasTargetMismatch()) {
      const warning = this.element.ownerDocument.createElement("p");
      warning.className = "cr-target-warning";
      warning.setAttribute("role", "status");
      warning.textContent = "Selection has a different bound target. Reassign explicitly or send separate batches.";
      this.element.querySelector(".cr-drawer > header")?.after(warning);
      const confirm = this.element.querySelector<HTMLButtonElement>("[data-action=confirm-send]");
      if (confirm) {
        confirm.disabled = true;
        confirm.title = warning.textContent;
      }
    }
    const source = this.element.querySelector(".cr-source");
    if (source) source.scrollTop = previousScroll;
    if (this.drawer && !focusId)
      this.element.querySelector<HTMLElement>(".cr-drawer button")?.focus();
    for (const option of this.element.querySelectorAll<HTMLOptionElement>(
      "option",
    ))
      if (!option.title)
        option.title = option.textContent || "Choose this option.";
    if (focusId) {
      const next = this.element.querySelector<HTMLElement>(
        "#" + CSS.escape(focusId),
      );
      next?.focus();
      if (
        next instanceof HTMLTextAreaElement ||
        next instanceof HTMLInputElement
      )
        try {
          next.setSelectionRange(selectionStart, selectionEnd);
        } catch {}
    }
  }
  private compose(threadId?: string) {
    this.draftEpoch++;
    const range = this.selection
      ? { startLine: this.selection.startLine, endLine: this.selection.endLine }
      : undefined;
    if (this.composer?.body)
      this.fileDrafts.set(this.composer.fileId, this.composer);
    this.composer = {
      body: "",
      fileId: this.fileId,
      threadId,
      range: threadId ? undefined : range,
      side: this.selection?.side || (this.view === "source" ? "source" : "new"),
      requestId: requestId(),
    };
    if (this.selection && !threadId) this.composer.side = this.selection.side;
    this.editMessage = null;
    this.commentThreadVersion = threadId
      ? this.threads.find((t) => t.id === threadId)?.version
      : undefined;
    this.setDirty(false);
    this.render();
    this.element.querySelector<HTMLTextAreaElement>("#cr-body")?.focus();
  }
  private async persistDraft() {
    if (this.draftPromise) return this.draftPromise;
    this.draftPromise = this.writeDraft().finally(() => {
      this.draftPromise = null;
    });
    return this.draftPromise;
  }
  private async writeDraft() {
    clearTimeout(this.draftTimer);
    if (!this.composer || !this.dirty || this.savingDraft || this.editMessage)
      return;
    const draft = this.composer,
      epoch = this.draftEpoch;
    draft.pending ??= {
      body: draft.body,
      requestId: requestId(),
      expectedVersion: draft.version,
    };
    const pending = draft.pending,
      body = pending.body;
    this.savingDraft = true;
    try {
      const saved = await this.api("draft", {
        draftId: draft.draftId,
        threadId: draft.threadId,
        ...(!draft.threadId
          ? { fileId: draft.fileId, side: draft.side, range: draft.range }
          : {}),
        body,
        expectedVersion: pending.expectedVersion,
        requestId: pending.requestId,
      });
      draft.draftId = saved.draftId;
      draft.version = saved.version;
      draft.pending = undefined;
      this.fileDrafts.set(draft.fileId, draft);
      if (epoch === this.draftEpoch && this.composer === draft) {
        this.setDirty(draft.body !== body);
        if (this.dirty)
          this.draftTimer = setTimeout(() => void this.persistDraft(), 500);
        this.render();
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.savingDraft = false;
    }
  }
  private click = (event: Event) => {
    const el = (event.target as Element).closest<HTMLElement>("[data-action]");
    if (!el || el.matches(":disabled") || this.busy) return;
    event.preventDefault();
    this.busy = true;
    void this.perform(el.dataset.action!, el)
      .catch((error) => this.fail(error))
      .finally(() => {
        this.busy = false;
      });
  };
  private async perform(name: string, el: HTMLElement) {
    const t = () => this.threads.find((t) => t.id === el.dataset.thread);
    if (name !== "options") this.moreMenu = false;
    // Switching composer/anchor never hides unacknowledged text or an in-flight draft write.
    if (
      [
        "line-comment",
        "range-comment",
        "file-comment",
        "reply",
        "edit",
        "drafts",
        "history",
        "add-file",
        "jump",
        "refresh",
        "staged",
        "unstaged",
      ].includes(name)
    ) {
      await this.persistDraft();
      if (this.dirty)
        throw Error(
          "Save or explicitly discard the pending comment before changing its context.",
        );
      if (this.composer?.body)
        this.fileDrafts.set(this.composer.fileId, this.composer);
    }
    switch (name) {
      case "load":
        await this.load();
        return;
      case "dismiss":
        this.status = "";
        break;
      case "dismiss-reply":
        if (this.pendingReply && confirm("Forget the pending reply marker? Saved drafts and published replies remain unchanged."))
          this.clearPendingReply(this.pendingReply.requestId);
        break;
      case "clear-recovery":
        if (!confirm("Clear the unreadable browser marker? Check saved replies and drafts first; this does not delete them.")) break;
        localStorage.removeItem(this.replyKey());
        this.replyStorageAvailable = true;
        this.pendingReply = null;
        this.status = "Browser marker cleared. Review saved replies and drafts before posting again.";
        break;
      case "reconcile-reply": {
        const pending = this.readPendingReply() ?? this.pendingReply;
        if (!pending) return;
        await this.reconcileReply(pending);
        break;
      }
      case "options":
        this.moreMenu = !this.moreMenu;
        break;
      case "files":
        this.showFiles = !this.showFiles;
        break;
      case "file":
        await this.persistDraft();
        if (this.dirty)
          throw Error(
            "Save or discard the current comment before changing file.",
          );
        this.fileScroll.set(
          this.fileId,
          this.element.querySelector(".cr-source")?.scrollTop || 0,
        );
        if (this.composer) this.fileDrafts.set(this.fileId, this.composer);
        if (this.selection)
          this.sourceSelection.set(this.fileId, this.selection);
        this.fileId = el.dataset.file!;
        this.page = 0;
        this.selection = this.sourceSelection.get(this.fileId) || null;
        this.composer = this.fileDrafts.get(this.fileId) || null;
        this.draftEpoch++;
        await this.loadContent();
        return;
      case "expand-context":
        this.contextExpanded = true;
        break;
      case "wrap":
        this.wrap = !this.wrap;
        break;
      case "layout":
        this.view = this.view === "split" ? "unified" : "split";
        break;
      case "previous":
        this.page = Math.max(0, this.page - 1);
        await this.loadContent();
        return;
      case "next":
        this.page++;
        await this.loadContent();
        return;
      case "line-comment":
        this.selection = {
          startLine: Number(el.dataset.line),
          endLine: Number(el.dataset.line),
          side: el.dataset.side!,
        };
        this.compose();
        return;
      case "select-line": {
        const line = Number(el.dataset.line),
          side = el.dataset.side!;
        this.selection =
          this.selection?.side === side
            ? {
                side,
                startLine: Math.min(this.selection.startLine, line),
                endLine: Math.max(this.selection.endLine, line),
              }
            : { side, startLine: line, endLine: line };
        break;
      }
      case "clear-range":
        this.selection = null;
        break;
      case "file-comment":
        this.selection = null;
        this.compose();
        return;
      case "range-comment":
        this.compose();
        return;
      case "threads":
        this.drawerFocus = el;
        this.drawer = "threads";
        break;
      case "close-drawer":
        this.drawer = null;
        this.sendIntent = null;
        this.sendPreview = null;
        this.pendingPayload = null;
        break;
      case "more-threads": {
        const rows = await this.api("threads", { after: this.threadPageAfter });
        this.threads.push(...rows);
        this.threadPageAfter = rows.at(-1)?.id || this.threadPageAfter;
        this.hasMoreThreads = rows.length === 50;
        await this.loadContent();
        return;
      }
      case "more-messages": {
        const data = this.detail.get(t().id);
        const next = await this.api("thread", {
          threadId: t().id,
          after: data.messages.at(-1)?.ordinal || 0,
        });
        this.detail.set(t().id, {
          ...next,
          messages: [...data.messages, ...next.messages],
        });
        this.moreMessages.set(t().id, next.messages.length === 100);
        break;
      }
      case "expand":
        if (this.detail.has(el.dataset.thread!))
          this.detail.delete(el.dataset.thread!);
        else await this.openThread(el.dataset.thread!);
        break;
      case "jump": {
        await this.persistDraft();
        if (this.dirty)
          throw Error("Save the comment draft before navigating.");
        const thread = t();
        this.drawer = null;
        await this.openThread(thread.id);
        const data = this.detail.get(thread.id);
        if (data.source.snapshotId !== this.snapshotId) {
          this.snapshotId = data.source.snapshotId;
          this.fileId = thread.anchor.snapshotFileId;
          await this.loadFiles();
        } else this.fileId = thread.anchor.snapshotFileId;
        this.page = Math.floor(
          Math.max(0, (thread.anchor.endLine || 1) - 1) / 300,
        );
        await this.loadContent();
        this.element
          .querySelector("#cr-" + thread.id)
          ?.scrollIntoView({ block: "center" });
        return;
      }
      case "reply":
        if (t().state === "resolved") throw Error("Reopen this concern first.");
        this.compose(t().id);
        this.commentThreadVersion =
          this.selectedThreadReads.get(t().id)?.version ?? t().version;
        return;
      case "edit": {
        const thread = t();
        const message = this.detail
          .get(thread.id)
          ?.messages.find((m: any) => m.id === el.dataset.message);
        this.compose(thread.id);
        this.editMessage = message;
        this.composer!.body = message.body;
        this.render();
        return;
      }
      case "cancel":
        clearTimeout(this.draftTimer);
        await this.draftPromise;
        if (this.composer?.pending) {
          this.status = "Draft acknowledgement is uncertain. Retry saving before discarding its persisted copy.";
          this.render();
          this.element.querySelector<HTMLTextAreaElement>("#cr-body")?.focus();
          return;
        }
        if (this.composer?.body && !confirm("Discard this unposted text?")) {
          // The dialog can restore focus to the button after this task.
          // Restore the draft after the current click finishes rendering.
          setTimeout(() => this.element.querySelector<HTMLTextAreaElement>("#cr-body")?.focus(), 0);
          return;
        }
        if (this.composer?.draftId)
          await this.api("deleteDraft", {
            draftId: this.composer.draftId,
            expectedVersion: this.composer.version,
            requestId: requestId(),
          });
        if (this.composer) this.fileDrafts.delete(this.composer.fileId);
        this.draftEpoch++;
        this.composer = null;
        this.editMessage = null;
        this.setDirty(false);
        break;
      case "post": {
        if (!this.composer?.body.trim()) throw Error("Write guidance first.");
        clearTimeout(this.draftTimer);
        await this.draftPromise;
        const draft = this.composer;
        if (draft.pending)
          throw Error(
            "Draft acknowledgement is uncertain; save it again before posting.",
          );
        if (this.editMessage)
          await this.api("edit", {
            messageId: this.editMessage.id,
            expectedVersion: this.editMessage.version,
            body: draft.body,
            requestId: draft.requestId,
          });
        else if (draft.threadId) {
          const previous = this.readPendingReply() ?? this.pendingReply;
          if (previous && previous.requestId !== draft.requestId) {
            const committed = await this.reconcileReply(previous);
            if (!committed)
              throw Error("Reconcile or dismiss the earlier reply before posting another.");
            if (this.pendingReply || this.readPendingReply())
              throw Error("Reconcile or dismiss the earlier reply before posting another.");
            if (this.composer !== draft) return;
            const latest = await this.api<{ version: number }>("thread", { threadId: draft.threadId, limit: 1 });
            this.commentThreadVersion = latest.version;
          }
          if (!previous && this.externallyReconciledThreads.has(draft.threadId)) {
            const latest = await this.api<{ version: number }>("thread", { threadId: draft.threadId, limit: 1 });
            this.commentThreadVersion = latest.version;
          }
          this.savePendingReply({
            requestId: draft.requestId,
            threadId: draft.threadId,
            ...(draft.draftId ? { draftId: draft.draftId, draftVersion: draft.version } : {}),
          });
          await this.api("reply", {
            threadId: draft.threadId,
            expectedVersion: this.commentThreadVersion,
            body: draft.body,
            requestId: draft.requestId,
          });
          this.clearPendingReply(draft.requestId);
          this.externallyReconciledThreads.delete(draft.threadId);
          this.status = "";
        } else
          await this.api("comment", {
            fileId: draft.fileId,
            side: draft.side,
            range: draft.range,
            body: draft.body,
            requestId: draft.requestId,
          });
        if (draft.draftId)
          try {
            await this.api("deleteDraft", {
              draftId: draft.draftId,
              expectedVersion: draft.version,
              requestId: requestId(),
            });
          } catch {
            this.status = "Comment saved. The draft changed or could not be removed; inspect saved drafts before deleting.";
          }
        this.fileDrafts.delete(draft.fileId);
        this.draftEpoch++;
        this.composer = null;
        this.editMessage = null;
        this.setDirty(false);
        if (!this.status) this.status = "Comment saved. No agent work queued.";
        await this.reloadThreads();
        return;
      }
      case "delete-message":
        if (confirm("Delete your message body and retain replies?")) {
          const message = this.detail
            .get(t().id)
            .messages.find((m: any) => m.id === el.dataset.message);
          await this.api("deleteMessage", {
            messageId: message.id,
            expectedVersion: message.version,
            confirm: true,
            requestId: requestId(),
          });
          await this.reloadThreads();
        }
        return;
      case "delete-thread":
        if (
          confirm(
            "Delete this discussion? Already delivered work cannot be recalled.",
          )
        ) {
          await this.api("deleteThread", {
            threadId: t().id,
            expectedVersion: t().version,
            confirm: true,
            requestId: requestId(),
          });
          this.detail.delete(t().id);
          await this.reloadThreads();
        }
        return;
      case "resolve": {
        const reason = prompt("Resolution explanation");
        if (reason === null) return;
        await this.api("resolve", {
          threadId: t().id,
          expectedVersion: t().version,
          explanation: reason,
          fileId: this.fileId,
          requestId: requestId(),
        });
        await this.reloadThreads();
        return;
      }
      case "reopen":
        await this.api("reopen", {
          threadId: t().id,
          expectedVersion: t().version,
          requestId: requestId(),
        });
        await this.reloadThreads();
        return;
      case "reassign":
        if (confirm(`Reassign this concern to ${this.activeTarget.label}?`)) {
          await this.api("reassign", {
            threadId: t().id,
            target: this.activeTarget,
            expectedVersion: t().version,
            requestId: requestId(),
          });
          await this.reloadThreads();
        }
        return;
      case "send-thread":
        this.selected.clear();
        this.selected.add(t().id);
        this.activeTarget = t().target; // fall through
      case "send":
      case "refresh-send-preview":
        this.sendPreview = null;
        this.sendIntent = null;
        this.pendingPayload = null;
        if (name === "refresh-send-preview") await this.reloadThreads();
        if (!this.selected.size) throw Error("No open selected threads remain; select guidance again.");
        if (this.hasTargetMismatch()) {
          this.drawer = "send";
          this.status = "";
          break;
        }
        const payload = {
          target: { ...this.activeTarget },
          items: this.selectionItems(),
          summary: this.summary,
        };
        this.pendingPayload = payload;
        const preview = await this.api<typeof this.sendPreview>("preview", payload);
        // Selection/target may change while the inert preview request is in flight.
        if (this.pendingPayload !== payload) return;
        this.sendPreview = preview;
        this.sendIntent = requestId();
        this.drawer = "send";
        this.status = "";
        break;
      case "confirm-send": {
        if (this.hasTargetMismatch()) throw Error("Reassign selected threads explicitly or send separate batches.");
        const intent = this.sendIntent;
        if (!intent || !this.pendingPayload || !this.sendPreview)
          throw Error("Preview the review before sending.");
        const result = await this.api("send", {
          ...this.pendingPayload,
          summary: this.summary,
          requestId: intent,
        });
        const attempt = result.attempts.at(-1);
        this.status = `Review ${result.id}: ${attempt.state}. ${attempt.state === "accepted" ? "Queued behind current work. No concern is resolved by queue acceptance." : "Inspect receipts before retrying."}`;
        this.drawer = null;
        this.selected.clear();
        this.sendIntent = null;
        this.sendPreview = null;
        this.pendingPayload = null;
        break;
      }
      case "refresh":
      case "staged":
      case "unstaged": {
        if (this.dirty)
          throw Error(
            "Save the pending comment draft before capturing a new source.",
          );
        const mode = name === "refresh" ? "source" : name;
        const capture = await this.api("capture", {
          source: {
            path: this.review.focus_path,
            mode,
            includeUntracked: true,
          },
          requestId: requestId(),
        });
        this.snapshots = await this.api("snapshots");
        this.snapshotId = capture.snapshotId;
        this.fileId = "";
        await this.reloadThreads();
        await this.loadFiles();
        return;
      }
      case "history": {
        let skip = 0;
        let row: any;
        for (;;) {
          const rows = await this.api<any[]>("history", {
            path: this.review.focus_path,
            limit: 20,
            skip,
          });
          if (!rows.length) throw Error("No further file history is available.");
          const pick = prompt(
            rows.map((r, i) =>
              `${i + 1}. ${r.commit.slice(0, 8)} ${r.subject}${r.path ? ` · ${r.path}${r.previousPath ? ` ← ${r.previousPath}` : ""}` : ""}`,
            ).join("\n") + `\nCommits ${skip + 1}–${skip + rows.length}. Enter a number${rows.length === 20 && skip + 20 < 10000 ? ", or N for older commits" : ""}.`,
          );
          if (pick === null) return;
          if (pick.trim().toLowerCase() === "n" && rows.length === 20 && skip + 20 < 10000) {
            skip += 20;
            continue;
          }
          const number = Number(pick);
          if (!Number.isSafeInteger(number) || number < 1 || number > rows.length)
            throw Error("Select a listed commit or the next history page.");
          row = rows[number - 1];
          break;
        }
        let parent;
        if (row.parents.length > 1) {
          const number = prompt(
            row.parents
              .map((p: string, i: number) => `${i + 1}. ${p}`)
              .join("\n") + "\nParent number",
          );
          if (number === null) return;
          parent = row.parents[Number(number) - 1];
          if (!parent) throw Error("Select a listed parent.");
        }
        const capture = await this.api("capture", {
          source: {
            path: row.path ?? this.review.focus_path,
            mode: "commit",
            commit: row.commit,
            parent,
          },
          requestId: requestId(),
        });
        this.snapshots = await this.api("snapshots");
        this.snapshotId = capture.snapshotId;
        await this.loadFiles();
        return;
      }
      case "add-file": {
        const path = prompt("Saved workspace-relative file path");
        if (!path) return;
        const capture = await this.api("addFile", {
          path,
          snapshotId: this.snapshotId,
          requestId: requestId(),
        });
        this.snapshots = await this.api("snapshots");
        this.snapshotId = capture.snapshotId;
        this.fileId = "";
        await this.loadFiles();
        return;
      }
      case "drafts": {
        this.savedDrafts = await this.api("drafts");
        const pick = prompt(
          this.savedDrafts
            .map((d: any, i: number) => `${i + 1}. ${d.body.slice(0, 80)}`)
            .join("\n") + "\nDraft number",
        );
        if (pick === null) return;
        const draft = this.savedDrafts[Number(pick) - 1];
        if (!draft) throw Error("Select a saved draft.");
        const anchor = draft.anchor_json ? JSON.parse(draft.anchor_json) : null;
        if (anchor && anchor.snapshotFileId !== this.fileId)
          throw Error("Open the draft’s original file snapshot first.");
        this.commentThreadVersion = draft.thread_id
          ? this.threads.find((t) => t.id === draft.thread_id)?.version
          : undefined;
        this.composer = {
          body: draft.body,
          fileId: this.fileId,
          threadId: draft.thread_id || undefined,
          side: anchor?.side || "source",
          range:
            anchor?.scope === "range"
              ? { startLine: anchor.startLine, endLine: anchor.endLine }
              : undefined,
          draftId: draft.id,
          version: draft.version,
          requestId: requestId(),
        };
        this.draftEpoch++;
        break;
      }
      case "receipts": {
        const rows = await this.api("dispatches");
        this.receipts = await Promise.all(
          rows
            .slice(0, 20)
            .map((row: any) => this.api("dispatch", { dispatchId: row.id })),
        );
        if (!rows.length) this.status = "No delivery attempts.";
        break;
      }
      case "close-receipts":
        this.receipts = null;
        break;
      case "retry": {
        if (!confirm("Retry this definitively rejected send?")) return;
        const result = await this.api("retry", {
          dispatchId: el.dataset.dispatch,
          requestId: requestId(),
        });
        this.status = "Retry outcome: " + result.attempts.at(-1).state;
        this.receipts = this.receipts!.map((d) =>
          d.id === result.id ? result : d,
        );
        break;
      }
      case "reconcile": {
        const receipt = this.receipts!.find(
            (d) => d.id === el.dataset.dispatch,
          ),
          last = receipt.attempts.at(-1);
        const decision = prompt(
          "After checking host receipts, type accepted or rejected. Cancel if still unknown.",
        );
        if (decision === null) return;
        if (!["accepted", "rejected"].includes(decision))
          throw Error(
            "Use accepted or rejected only when evidence establishes it.",
          );
        const evidence = prompt(
          "Public evidence or receipt reference supporting this decision",
        );
        if (!evidence) return;
        await this.api("reconcile", {
          dispatchId: receipt.id,
          attemptId: last.id,
          decision,
          evidence,
          confirm: true,
          requestId: requestId(),
        });
        const updated = await this.api("dispatch", { dispatchId: receipt.id });
        this.receipts = this.receipts!.map((d) =>
          d.id === updated.id ? updated : d,
        );
        break;
      }
      case "reanchor": {
        if (!this.selection) throw Error("Select a saved range.");
        const id = prompt("Thread ID to re-anchor");
        if (!id) return;
        const thread = this.threads.find((t) => t.id === id);
        if (!thread) throw Error("Choose a thread in this review.");
        if (
          !confirm(
            thread.state === "resolved"
              ? "Reopen and re-anchor this concern?"
              : "Re-anchor this concern?",
          )
        )
          return;
        await this.api("reanchor", {
          threadId: id,
          fileId: this.fileId,
          side: this.selection.side,
          range: {
            startLine: this.selection.startLine,
            endLine: this.selection.endLine,
          },
          reopen: thread.state === "resolved",
          confirm: true,
          expectedVersion: thread.version,
          requestId: requestId(),
        });
        await this.reloadThreads();
        return;
      }
    }
    this.render();
  }
  private selectionItems() {
    return [...this.selected].map((id) => {
      const t = this.threads.find((t) => t.id === id);
      return { threadId: id, version: t.version };
    });
  }
  private change = (event: Event) => {
    const el = event.target as HTMLInputElement;
    if (
      !el.dataset.pick &&
      !["cr-target", "cr-snapshot", "cr-thread-filter"].includes(el.id)
    )
      return;
    void (async () => {
      if (el.dataset.pick) {
        el.checked
          ? this.selected.add(el.dataset.pick)
          : this.selected.delete(el.dataset.pick);
        if (this.drawer === "send" || this.pendingPayload) {
          this.pendingPayload = null;
          this.sendPreview = null;
          this.sendIntent = null;
        }
      } else if (el.id === "cr-target") {
        const selected = this.targets.find((t) => t.chatJid === el.value);
        this.activeTarget = {
          chatId: selected.chatJid,
          incarnation: selected.incarnation,
          label: selected.label,
        };
        this.sendIntent = null;
        this.sendPreview = null;
        this.pendingPayload = null;
      } else if (el.id === "cr-snapshot") {
        if (this.dirty) throw Error("Save the comment draft first.");
        this.snapshotId = el.value;
        await this.loadFiles();
      } else if (el.id === "cr-thread-filter") this.threadFilter = el.value;
      this.render();
    })().catch((error) => this.fail(error));
  };
  private input = (event: Event) => {
    const el = event.target as HTMLInputElement;
    if (el.id === "cr-body" && this.composer) {
      this.composer.body = el.value;
      this.composer.requestId = requestId();
      this.setDirty(true);
      clearTimeout(this.draftTimer);
      this.draftTimer = setTimeout(() => void this.persistDraft(), 500);
    } else if (el.id === "cr-summary") {
      this.summary = el.value;
      if (this.drawer === "send") {
        this.sendIntent = requestId();
      }
    } else if (el.id === "cr-filter") {
      this.fileFilter = el.value;
      this.render();
    }
  };
  private copySource = (event: ClipboardEvent) => {
    const selection = this.element.ownerDocument.getSelection();
    const source = this.element.querySelector(".cr-source");
    if (!source || !selection || selection.isCollapsed || !event.clipboardData ||
        !source.contains(selection.anchorNode) || !source.contains(selection.focusNode)) return;
    const range = selection.getRangeAt(0);
    const rows = [...source.querySelectorAll<HTMLElement>(".cr-line[data-line]")].filter((row) =>
      range.intersectsNode(row.querySelector("code")!),
    );
    if (!rows.length) return;
    const copied = rows.map((row) => {
      const code = row.querySelector("code")!;
      const selected = range.cloneRange();
      selected.selectNodeContents(code);
      if (code.contains(range.startContainer))
        selected.setStart(range.startContainer, range.startOffset);
      if (code.contains(range.endContainer))
        selected.setEnd(range.endContainer, range.endOffset);
      return selected.toString();
    }).join("\n");
    event.clipboardData.setData("text/plain", copied);
    event.preventDefault();
  };
  private keydown = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void this.persistDraft();
    }
    if (event.key === "Tab" && this.drawer) {
      const nodes = [
        ...this.element.querySelectorAll<HTMLElement>(
          ".cr-drawer button:not(:disabled),.cr-drawer input:not(:disabled),.cr-drawer select,.cr-drawer textarea",
        ),
      ].filter((n) => n.offsetParent !== null);
      const first = nodes[0],
        last = nodes.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    if (event.key === "Escape") {
      if (this.moreMenu || this.drawer) {
        event.preventDefault();
        event.stopPropagation();
        if (this.moreMenu) {
          this.moreMenu = false;
          this.render();
        } else {
          this.drawer = null;
          this.render();
          this.element.querySelector<HTMLElement>("[data-action=threads]")?.focus();
        }
      }
    }
  };
}
export const reviewPane = {
  id: "code-review",
  label: "Code Review",
  capabilities: ["readonly"],
  placement: "tabs",
  canHandle(context: any) {
    return typeof context.path === "string" &&
      context.path.startsWith(pathPrefix)
      ? 100
      : false;
  },
  mount(container: HTMLElement, context: any) {
    return new CodeReviewPane(container, context);
  },
};
