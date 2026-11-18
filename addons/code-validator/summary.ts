import {
  summaryArgs,
  summaryJoin,
  summaryValue,
  type ToolCallSummary,
} from "./compat/tool-call-summary.js";

const diagnosticsSummary: ToolCallSummary = (input) => {
  const args = summaryArgs(input);
  const file = summaryValue(args.file);
  return file ? summaryJoin("validate code", file) : "list code validators";
};

export const callSummaries: Readonly<Record<string, ToolCallSummary>> = Object.freeze({
  diagnostics: diagnosticsSummary,
});
