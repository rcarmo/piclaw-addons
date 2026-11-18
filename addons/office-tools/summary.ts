import { summaryArgs, summaryValue, summaryFields, summaryFirst, summaryJoin, summaryChoice, summaryWords, summaryRequest, type ToolCallSummary } from './compat/tool-call-summary.js';
export const callSummaries: Readonly<Record<string, ToolCallSummary>> = Object.freeze({
  office_read: input => summaryJoin("read Office document", summaryFields(summaryArgs(input), "path")),
  office_write: input => summaryJoin("write Office document", summaryFields(summaryArgs(input), "path")),
});
