import { PROXMOX_WORKFLOW_CAPABILITIES } from './workflow-capabilities.js';
import { summaryArgs, summaryValue, summaryFirst, summaryJoin, summaryChoice, summaryRequest, type ToolCallSummary } from './compat/tool-call-summary.js';

const actions: Readonly<Record<string, string>> = Object.freeze({
  get: 'read API profile', set: 'update API profile', clear: 'clear API profile', discover: 'discover API profiles',
  contract: 'read API contract', capabilities: 'list workflow capabilities', request_help: 'show API request help', recommend: 'recommend workflows',
});
export const callSummaries: Readonly<Record<string, ToolCallSummary>> = Object.freeze({
  proxmox(input) {
    const args = summaryArgs(input);
    const action = summaryChoice(args.action, Object.keys(actions).join(' ') + ' request workflow workflow_help');
    if (action === 'request') return summaryRequest(args);
    if (action === 'workflow' || action === 'workflow_help') {
      const workflow = typeof args.workflow === 'string' && Object.hasOwn(PROXMOX_WORKFLOW_CAPABILITIES, args.workflow) ? args.workflow : '';
      const label = workflow ? PROXMOX_WORKFLOW_CAPABILITIES[workflow].callSummary : null;
      if (action === 'workflow_help') return summaryJoin('workflow help', label);
      const target = /^(vm\.|lxc\.|backup\.|metrics\.vm)/.test(workflow) ? summaryFirst(args, 'vmid', 'name', 'hostname')
        : workflow.startsWith('task.') ? summaryValue(args.upid) : summaryValue(args.storage);
      return summaryJoin(label || 'run workflow', target, summaryValue(args.node));
    }
    return summaryJoin(actions[action] ?? 'manage API connection',
      action === 'capabilities' || action === 'recommend' ? summaryValue(args.category) : null,
      action === 'set' ? summaryValue(args.base_url) : null);
  },
});
