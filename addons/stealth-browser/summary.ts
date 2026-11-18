import {
  summaryArgs,
  summaryChoice,
  summaryJoin,
  summaryValue,
  type ToolCallSummary,
} from "./compat/tool-call-summary.js";

const ACTIONS = "goto click type scroll screenshot evaluate text fetch cookies status close";

const stealthBrowserSummary: ToolCallSummary = (input) => {
  const args = summaryArgs(input);
  const action = summaryChoice(args.action, ACTIONS);
  const operationMap: Record<string, string> = {
    goto: "open page",
    click: "click page element",
    type: "type text",
    scroll: "scroll page",
    screenshot: "capture page",
    evaluate: "run browser script",
    text: "read page text",
    fetch: "fetch page",
    cookies: "inspect browser cookies",
    status: "show browser status",
    close: "close browser",
  };
  const operation = operationMap[action] ?? "control browser";
  let focus: string | null = null;
  if (action === "goto" || action === "fetch") {
    focus = summaryValue(args.url);
  } else if (action === "click" || action === "type" || action === "text") {
    focus = summaryValue(args.selector);
  } else if (action === "screenshot") {
    focus = summaryValue(args.outPath);
  }
  return summaryJoin(operation, focus);
};

export const callSummaries: Readonly<Record<string, ToolCallSummary>> = Object.freeze({
  stealth_browser: stealthBrowserSummary,
});
