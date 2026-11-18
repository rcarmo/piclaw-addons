import {
  summaryArgs,
  summaryChoice,
  summaryFields,
  summaryJoin,
  summaryValue,
  type ToolCallSummary,
} from "./compat/tool-call-summary.js";

const gitHistorySummary: ToolCallSummary = (input) => {
  const args = summaryArgs(input);
  const action = summaryChoice(args.mode, "log content_search message_search blame");
  const target = summaryFields(args, "file", "ref");
  switch (action) {
    case "log":
      return summaryJoin("read commit history", target || null);
    case "content_search":
      return summaryJoin("search code history", target || null);
    case "message_search":
      return summaryJoin("search commit messages", target || null);
    case "blame":
      return summaryJoin("show line authorship", target || null);
    default:
      return "read commit history";
  }
};

const jsonQuerySummary: ToolCallSummary = (input) => {
  const args = summaryArgs(input);
  if (typeof args.keys_only === "boolean" && args.keys_only) {
    return summaryJoin("list JSON keys", summaryValue(args.file));
  }
  const file = summaryValue(args.file);
  if (file) {
    return summaryJoin("query JSON file", file);
  }
  if (typeof args.input !== "undefined") {
    return "query inline JSON";
  }
  return "query JSON data";
};

export const callSummaries: Readonly<Record<string, ToolCallSummary>> = Object.freeze({
  git_history: gitHistorySummary,
  json_query: jsonQuerySummary,
});
