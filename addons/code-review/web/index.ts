import { action, requestId } from "./api.ts";
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
