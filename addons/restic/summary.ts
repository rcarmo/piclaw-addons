import { summaryArgs, summaryValue, summaryFields, summaryFirst, summaryJoin, summaryChoice, summaryWords, summaryRequest, type ToolCallSummary } from './compat/tool-call-summary.js';
const actions: Readonly<Record<string, string>> = Object.freeze({ get_config: 'read backup configuration', set_config: 'update backup configuration', status: 'show backup status' });
export const callSummaries: Readonly<Record<string, ToolCallSummary>> = Object.freeze({
  restic: input => actions[summaryChoice(summaryArgs(input).action, Object.keys(actions).join(' '))] ?? 'manage backup configuration',
});
