import { action, requestId, escapeText } from "./api.ts";
import { reviewPane } from "./pane.ts";
import { styles, actionStyles } from "./styles.ts";
const runtime = (globalThis as Record<string, any>).__piclaw_web;
const prefix = "piclaw://addon/code-review/";
let installed = false;
export function installCodeReviewWeb(host = runtime) {
  if (installed || !host || typeof document === "undefined") return;
  if (
    host.workspaceActionsVersion !== 1 ||
    typeof host.registerWorkspaceAction !== "function" ||
    typeof host.openPane !== "function"
  )
    return;
  installed = true;
  const style = document.createElement("style");
  style.dataset.addon = "code-review";
  style.textContent = styles + actionStyles;
  document.head.append(style);
  host.registerPane(reviewPane);
  host.registerWorkspaceAction({
    id: "code-review.review-file",
    label: "Review file",
    icon: "review",
    title:
      "Review this saved file with inline comments; no code is edited and no agent work starts.",
    when: (context: any) => context?.type === "file",
    async run(context: any) {
      const targets = await action<any[]>("targets");
      if (!targets.length)
        throw Error("No authorised local agent is available for this review.");
      const suggested =
        targets.find((t) => t.chatJid === context.chatJid) || targets[0];
      const reviews = await action<any[]>("list");
      const existing = reviews.find((r) => r.focus_path === context.path);
      let reviewId: string;
      if (
        existing &&
        confirm(
          `Reopen existing review “${existing.title}”? Choose Cancel to create a separate review.`,
        )
      )
        reviewId = existing.id;
      else {
        const result = await action<any>("create", {
          path: context.path,
          title: context.name || context.path,
          target: {
            chatId: suggested.chatJid,
            incarnation: suggested.incarnation,
          },
          requestId: requestId(),
        });
        reviewId = result.reviewId;
      }
      if (
        !host.openPane({
          path: prefix + reviewId,
          label: "Review · " + (context.name || context.path.split("/").pop()),
          paneId: "code-review",
        })
      )
        throw Error("Host could not open the review pane.");
    },
  });
}
installCodeReviewWeb();
export default installCodeReviewWeb;

function ReviewSettings() {
  const preact = (globalThis as any).__piclawPreactHtm || (globalThis as any).__piclawPreact;
  const { html, useRef, useEffect } = preact;
  const ref = useRef(null);
  useEffect(() => {
    const node = ref.current as HTMLElement;
    const abort = new AbortController();
    let rows: any[] = [], days: number | null = null, status = '', busy = false, after = '', more = false;
    const deleteRequests = new Map<string, string>();
    const api = (name: string, data: Record<string, unknown> = {}) => action(name, data, abort.signal);
    const render = () => {
      if (abort.signal.aborted) return;
      node.innerHTML = `<h3>Reviews</h3><p>Open saved reviews even when the source file is gone. Deleting a review removes its discussions, drafts and saved versions, never source files.</p>
      <div class="cr-retention"><label><input id="cr-retention-enabled" type="checkbox" ${days !== null ? 'checked' : ''} title="Automatically delete inactive reviews after the configured age."> Automatically delete reviews older than</label><input id="cr-retention-days" type="number" min="1" max="3650" value="${days ?? 30}" aria-label="Review retention days" title="Days since the last review activity." ${days === null ? 'disabled' : ''}> days <button data-settings-action="save" title="Save the automatic deletion policy; source files are never deleted." ${busy ? 'disabled' : ''}>Save</button></div>
      <small>Off by default. Checks hourly while Piclaw is running and when this page refreshes. Queued, running and uncertain work is skipped.</small>
      <div role="status">${escapeText(status)}</div><div><button data-settings-action="refresh" title="Refresh saved reviews and apply the enabled cleanup policy." ${busy ? 'disabled' : ''}>Refresh</button></div>
      <div class="cr-review-list">${rows.length ? rows.map(r => `<article><div class="cr-review-description"><strong>${escapeText(r.title)}</strong><small>${escapeText(r.focus_path)}</small><small>Last activity: ${escapeText(r.updated_at)}</small></div><button data-settings-action="open" data-review="${escapeText(r.id)}" title="Open stored review snapshots without requiring the original file." ${busy ? 'disabled' : ''}>Open</button><button data-settings-action="delete" data-review="${escapeText(r.id)}" title="Permanently delete this review, its messages, drafts and saved versions." data-settings-button="danger" ${busy ? 'disabled' : ''}>Delete</button></article>`).join('') : '<p>No saved reviews.</p>'}</div>
      ${more ? '<button data-settings-action="more" title="Load more saved reviews.">More reviews</button>' : ''}`;
    };
    const load = async () => {
      const settings = await api('getSettings'); days = settings.retentionDays;
      await api('cleanup');
      rows = await api('list'); after = rows.at(-1)?.id || ''; more = rows.length === 50;
      render();
    };
    const click = async (event: Event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-settings-action]');
      if (!button || busy) return;
      const name = button.dataset.settingsAction, row = rows.find(r => r.id === button.dataset.review);
      if (name === 'open') {
        const web = (globalThis as any).__piclaw_web;
        if (!web?.openPane?.({path:`piclaw://addon/code-review/${row.id}`,paneId:'code-review',label:`Review · ${row.title}`})) {status='Review pane is unavailable.';render();}
        return;
      }
      let nextDays: number | null = null;
      if (name === 'save') {
        nextDays = node.querySelector<HTMLInputElement>('#cr-retention-enabled')!.checked ? Number(node.querySelector<HTMLInputElement>('#cr-retention-days')!.value) : null;
        if (nextDays !== null && (!Number.isInteger(nextDays) || nextDays < 1 || nextDays > 3650)) {status='Choose a whole number from 1 to 3650 days.';render();return;}
        if (nextDays !== null && !confirm(`Automatically delete reviews inactive for ${nextDays} days, including their messages, drafts and saved versions? Source files are never deleted.`)) return;
      }
      if (name === 'delete' && !confirm('Delete this review and all its discussions, drafts and saved versions? Source files are not deleted. Already dispatched agent work cannot be recalled.')) return;
      busy = true; status = ''; render();
      try {
        if (name === 'delete') {
          const request = deleteRequests.get(row.id) || requestId(); deleteRequests.set(row.id, request);
          await api('deleteReview',{reviewId:row.id,expectedVersion:row.version,requestId:request,confirm:true});
          deleteRequests.delete(row.id);status='Review deleted.';
        } else if (name === 'save') {
          await api('saveSettings',{retentionDays:nextDays,confirm:true});status='Settings saved.';
        } else if (name === 'more') {
          const page = await api('list',{after});rows.push(...page);after=page.at(-1)?.id||after;more=page.length===50;return;
        }
        await load();
      } catch(error) {if(!abort.signal.aborted)status=(error as Error).message;}
      finally {busy=false;render();}
    };
    node.addEventListener('click',click);
    const change = () => {node.querySelector<HTMLInputElement>('#cr-retention-days')!.disabled=!node.querySelector<HTMLInputElement>('#cr-retention-enabled')!.checked;};
    node.addEventListener('change',change);
    render();void load().catch(error=>{if(!abort.signal.aborted){status=error.message;render();}});
    return () => {abort.abort();node.removeEventListener('click',click);node.removeEventListener('change',change);};
  }, []);
  return html`<section ref=${ref} class="cr-reviews-settings" aria-label="Code Review settings"></section>`;
}
const settingsRegistry = (globalThis as any).__piclaw_web;
settingsRegistry?.registerSettingsPane?.({id:'code-review',label:'Code Review',component:ReviewSettings,order:210});
