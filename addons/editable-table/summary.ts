import { summaryArgs, summaryValue, summaryFields, summaryFirst, summaryJoin, summaryChoice, summaryWords, summaryRequest, type ToolCallSummary } from './compat/tool-call-summary.js';
export const callSummaries: Readonly<Record<string, ToolCallSummary>> = Object.freeze({
  editable_table: input => summaryJoin("edit Markdown table", summaryFields(summaryArgs(input), "title")),
});
