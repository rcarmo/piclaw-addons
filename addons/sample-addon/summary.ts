import { summaryArgs, summaryValue, summaryFields, summaryFirst, summaryJoin, summaryChoice, summaryWords, summaryRequest, type ToolCallSummary } from './compat/tool-call-summary.js';
export const callSummaries: Readonly<Record<string, ToolCallSummary>> = Object.freeze({
  sample_test: input => summaryJoin("run sample add-on check", summaryFields(summaryArgs(input))),
});
