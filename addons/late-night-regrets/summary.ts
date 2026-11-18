import { summaryArgs, summaryValue, summaryFields, summaryFirst, summaryJoin, summaryChoice, summaryWords, summaryRequest, type ToolCallSummary } from './compat/tool-call-summary.js';
export const callSummaries: Readonly<Record<string, ToolCallSummary>> = Object.freeze({
  regrets_review: input => summaryJoin("review recent human feedback", summaryFields(summaryArgs(input))),
});
