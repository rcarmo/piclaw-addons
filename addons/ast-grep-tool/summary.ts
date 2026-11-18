import {
  summaryArgs,
  summaryJoin,
  summaryValue,
  type ToolCallSummary,
} from "./compat/tool-call-summary.js";

const codeSearchSummary: ToolCallSummary = (input) => {
  const args = summaryArgs(input);
  const lang = summaryValue(args.lang);
  const path = summaryValue(args.path);
  return summaryJoin("search code", lang, path);
};

const codeRewriteSummary: ToolCallSummary = (input) => {
  const args = summaryArgs(input);
  const lang = summaryValue(args.lang);
  const path = summaryValue(args.path);
  const preview = args.dry_run !== false && args.dry_run !== "false";
  return summaryJoin(preview ? "preview code rewrite" : "rewrite code", lang, path);
};

export const callSummaries: Readonly<Record<string, ToolCallSummary>> = Object.freeze({
  code_search: codeSearchSummary,
  code_rewrite: codeRewriteSummary,
});
