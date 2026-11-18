import {
  summaryArgs,
  summaryJoin,
  summaryValue,
  type ToolCallSummary,
} from "./compat/tool-call-summary.js";

const ventSummary: ToolCallSummary = (input) => {
  const args = summaryArgs(input);
  return summaryJoin("record feedback", summaryValue(args.trigger));
};

export const callSummaries: Readonly<Record<string, ToolCallSummary>> = Object.freeze({
  vent: ventSummary,
});
