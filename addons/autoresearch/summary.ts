import {
  summaryArgs,
  summaryJoin,
  summaryValue,
  type ToolCallSummary,
} from "./compat/tool-call-summary.js";

const startAutoresearchSummary: ToolCallSummary = (input) => {
  const args = summaryArgs(input);
  return summaryJoin("start experiment", summaryValue(args.project_dir));
};

const stopAutoresearchSummary: ToolCallSummary = () => "stop experiment";
const autoresearchStatusSummary: ToolCallSummary = () => "show experiment status";

export const callSummaries: Readonly<Record<string, ToolCallSummary>> = Object.freeze({
  start_autoresearch: startAutoresearchSummary,
  stop_autoresearch: stopAutoresearchSummary,
  autoresearch_status: autoresearchStatusSummary,
});
