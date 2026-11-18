import { summaryArgs, summaryValue, summaryFields, summaryFirst, summaryJoin, summaryChoice, summaryWords, summaryRequest, type ToolCallSummary } from './compat/tool-call-summary.js';
const actions: Readonly<Record<string, string>> = Object.freeze({
  status: 'show peer status', identity: 'show client identity', ticket: 'create pairing ticket', pair: 'pair client', accept: 'accept pairing', deny: 'deny pairing',
  revoke: 'revoke peer access', forget: 'forget peer', rotate: 'rotate client identity', alias: 'set peer alias', policy: 'update peer permissions',
  remote_permissions: 'read remote permissions', advertise: 'advertise discovery', unadvertise: 'stop discovery', session_targets: 'list session targets',
  session_advertise: 'advertise session', session_unadvertise: 'stop advertising session', ping: 'ping peer', retry: 'retry delivery', work_send: 'send work request', work_review: 'review work request',
});
export const callSummaries: Readonly<Record<string, ToolCallSummary>> = Object.freeze({
  remote_peer(input) {
    const args = summaryArgs(input), action = summaryChoice(args.action, Object.keys(actions).join(' '));
    return summaryJoin(actions[action] ?? 'manage peers', summaryFirst(args, 'peer', 'client_id'), summaryFirst(args, 'agent', 'session_alias', 'request_id', 'message_id'));
  },
});
