import {
  summaryArgs,
  summaryChoice,
  type ToolCallSummary,
} from "./compat/tool-call-summary.js";

const cheapSkateSummary: ToolCallSummary = (input) => {
  const args = summaryArgs(input);
  const action = summaryChoice(args.action, "status list usage rotate");
  switch (action) {
    case "status":
      return "show provider rotation status";
    case "list":
      return "list routing models";
    case "usage":
      return "show routing usage";
    case "rotate":
      return "rotate routing provider";
    default:
      return "manage provider rotation";
  }
};

export const callSummaries: Readonly<Record<string, ToolCallSummary>> = Object.freeze({
  cheapskate: cheapSkateSummary,
});
