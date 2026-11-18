import { summaryArgs, summaryValue, summaryFields, summaryFirst, summaryJoin, summaryChoice, summaryWords, summaryRequest, type ToolCallSummary } from './compat/tool-call-summary.js';
const actions: Readonly<Record<string, string>> = Object.freeze({
  dispatches: 'list assigned review batches', dispatch: 'read review batch', thread: 'read review thread', threads: 'list review threads',
  reply: 'reply to review thread', edit: 'edit review reply', deleteMessage: 'delete review reply', resolve: 'resolve review thread', work: 'update review progress',
});
export const callSummaries: Readonly<Record<string, ToolCallSummary>> = Object.freeze({
  code_review(input) {
    const args = summaryArgs(input), action = summaryChoice(args.action, Object.keys(actions).join(' '));
    const state = summaryChoice(args.state, 'in_progress waiting_user blocked failed completed superseded');
    return summaryJoin(actions[action] ?? 'inspect code reviews', summaryFirst(args, 'threadId', 'messageId', 'dispatchId', 'reviewId', 'requestId'), state || null);
  },
});
