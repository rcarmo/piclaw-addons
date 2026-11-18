import { summaryArgs, summaryValue, summaryFields, summaryFirst, summaryJoin, summaryChoice, summaryWords, summaryRequest, type ToolCallSummary } from './compat/tool-call-summary.js';
const actions = 'list_accounts get_account save_account delete_account set_default_account list_folders search fetch move copy flag create_draft file_message create_folder delete_folder';
export const callSummaries: Readonly<Record<string, ToolCallSummary>> = Object.freeze({
  imap(input) {
    const args = summaryArgs(input), action = summaryChoice(args.action, actions);
    const operation = action === 'list_folders' ? 'list mail folders' : action.includes('account') ? summaryWords(action) : summaryWords(action || 'manage') + ' mail';
    return summaryJoin(operation, summaryValue(args.account), [summaryValue(args.folder), summaryValue(args.targetFolder)].filter(Boolean).join(' → '));
  },
});
