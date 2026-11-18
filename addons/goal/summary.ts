import { summaryArgs, summaryValue, summaryFields, summaryFirst, summaryJoin, summaryChoice, summaryWords, summaryRequest, type ToolCallSummary } from './compat/tool-call-summary.js';
export const callSummaries: Readonly<Record<string, ToolCallSummary>> = Object.freeze({
  get_goal: () => 'read current goal',
  create_goal: () => 'create goal',
  goal_complete: () => 'mark goal complete',
  goal_stop: () => 'stop goal loop',
  update_goal: input => {
    const status = summaryChoice(summaryArgs(input).status, 'complete blocked');
    return status === 'complete' ? 'mark goal complete' : status === 'blocked' ? 'mark goal blocked' : 'update goal';
  },
});
