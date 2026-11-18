import { summaryArgs, summaryValue, summaryFields, summaryFirst, summaryJoin, summaryChoice, summaryWords, summaryPath, summaryMethod, type ToolCallSummary } from './compat/tool-call-summary.js';

// Only these selectors enter the collapsed timeline. Message bodies, notes,
// recipients, queries, scripts, ETags and request keys are deliberately omitted.
const fixed: Readonly<Record<string, readonly [string, ...string[]]>> = Object.freeze({
  m365_teams_chats: ['list Teams chats'],
  m365_teams_messages: ['read Teams messages', 'chatId'],
  m365_teams_send: ['send Teams message', 'chatId'],
  m365_teams_send_rich_text: ['send Teams rich-text message', 'chatId'],
  m365_teams_send_markdown_card: ['send Teams Markdown card', 'chatId', 'fileName'],
  m365_teams_upload_file_card: ['upload Teams file card', 'chatId', 'localPath'],
  m365_teams_send_link_card: ['send Teams link card', 'chatId', 'url'],
  m365_teams_send_file_card: ['send Teams file card', 'chatId', 'localPath'],
  m365_people: ['search people'],
  m365_calendar_svg: ['draw calendar', 'date'],
  m365_document_link_metadata: ['inspect document link', 'url'],
  m365_onedrive_share_local_file: ['share OneDrive file', 'localPath'],
  m365_spo_search: ['search SharePoint', 'siteUrl'],
  m365_spo_browse: ['browse SharePoint', 'siteUrl', 'folderPath'],
  m365_spo_download: ['download SharePoint file', 'siteUrl', 'filePath'],
  m365_spo_upload: ['upload SharePoint file', 'localPath', 'folderId'],
  m365_spo_sync: ['sync SharePoint folder', 'localDir', 'folderId'],
  m365_spo_move: ['move SharePoint item', 'filePath', 'itemId'],
});
const summaries: Record<string, ToolCallSummary> = {};
for (const [name, [label, ...fields]] of Object.entries(fixed)) {
  summaries[name] = input => summaryJoin(label, summaryFields(summaryArgs(input), ...fields));
}
const profileActions: Readonly<Record<string, string>> = Object.freeze({
  profile: 'read user profile', manager: 'read manager profile', calendar_today: 'read today’s calendar', calendar_upcoming: 'read upcoming calendar',
});
Object.assign(summaries, {
  m365_graph_query: (input: unknown) => {
    const args = summaryArgs(input), path = summaryPath(args.path);
    return path ? `${summaryMethod(args.method)} ${path}` : 'query Microsoft Graph';
  },
  m365_profile: (input: unknown) => profileActions[summaryChoice(summaryArgs(input).action, Object.keys(profileActions).join(' '))] ?? 'read user profile',
  m365_mail: (input: unknown) => {
    const args = summaryArgs(input);
    const action = summaryChoice(args.action, 'list search read draft reply forward delete move flag mark_read mark_unread folders batch_delete batch_move batch_archive batch_flag');
    return summaryJoin(action === 'folders' ? 'list mail folders' : `${summaryWords(action || 'manage')} mail`, summaryFields(args, 'messageId', 'folder'));
  },
  m365_onedrive: (input: unknown) => {
    const args = summaryArgs(input), action = summaryChoice(args.action, 'list search info mkdir delete');
    const label = action === 'info' ? 'inspect OneDrive item' : action === 'mkdir' ? 'create OneDrive folder' : `${action || 'browse'} OneDrive items`;
    return summaryJoin(label, summaryFirst(args, 'itemPath', 'folderPath', 'itemId'));
  },
  m365_calendar: (input: unknown) => {
    const args = summaryArgs(input), action = summaryChoice(args.action, 'list create update delete rsvp availability');
    return summaryJoin(action === 'availability' ? 'find calendar availability' : `${action || 'manage'} calendar events`, summaryFields(args, 'eventId', 'date'));
  },
  m365_spo_move_many: (input: unknown) => {
    const args = summaryArgs(input);
    return summaryJoin('move SharePoint items', Array.isArray(args.items) ? `${args.items.length} items` : null);
  },
  m365_todo: (input: unknown) => {
    const args = summaryArgs(input);
    return summaryJoin('list tasks and flagged mail', Array.isArray(args.listIds) && args.listIds.length ? `${args.listIds.length} lists` : null);
  },
  m365_todo_lists: (input: unknown) => {
    const args = summaryArgs(input), action = summaryChoice(args.action, 'list get create rename delete');
    return summaryJoin(`${action || 'manage'} task lists`, summaryValue(args.listId));
  },
  m365_todo_task: (input: unknown) => {
    const args = summaryArgs(input), action = summaryChoice(args.action, 'get create update complete reopen delete');
    return summaryJoin(`${action || 'manage'} task`, summaryFields(args, 'listId', 'taskId'));
  },
  m365_todo_step: (input: unknown) => {
    const args = summaryArgs(input), action = summaryChoice(args.action, 'list create update delete');
    return summaryJoin(`${action || 'manage'} checklist steps`, summaryFields(args, 'listId', 'taskId', 'stepId'));
  },
});
export const callSummaries: Readonly<Record<string, ToolCallSummary>> = Object.freeze(summaries);
