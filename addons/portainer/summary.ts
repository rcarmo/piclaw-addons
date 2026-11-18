import { PORTAINER_WORKFLOW_CAPABILITIES } from './workflow-capabilities.js';
import { summaryArgs, summaryValue, summaryFirst, summaryJoin, summaryChoice, summaryRequest, type ToolCallSummary } from './compat/tool-call-summary.js';

const actions: Readonly<Record<string, string>> = Object.freeze({
  get: 'read API profile', set: 'update API profile', clear: 'clear API profile', discover: 'discover API profiles',
  contract: 'read API contract', capabilities: 'list workflow capabilities', request_help: 'show API request help', recommend: 'recommend workflows',
});
export const callSummaries: Readonly<Record<string, ToolCallSummary>> = Object.freeze({
  portainer(input) {
    const args = summaryArgs(input);
    const action = summaryChoice(args.action, Object.keys(actions).join(' ') + ' request workflow workflow_help');
    if (action === 'request') return summaryRequest(args);
    if (action === 'workflow' || action === 'workflow_help') {
      const workflow = typeof args.workflow === 'string' && Object.hasOwn(PORTAINER_WORKFLOW_CAPABILITIES, args.workflow) ? args.workflow : '';
      const label = workflow ? PORTAINER_WORKFLOW_CAPABILITIES[workflow].callSummary : null;
      if (action === 'workflow_help') return summaryJoin('workflow help', label);
      const family = workflow.split('.')[0];
      const target = family === 'stack' ? summaryFirst(args, 'stack_id', 'stack_name', 'name')
        : family === 'container' ? (Array.isArray(args.names) && args.names.length ? `${args.names.length} containers` : summaryFirst(args, 'name', 'container_id'))
          : family === 'image' ? summaryFirst(args, 'image', 'name')
            : family === 'network' ? summaryFirst(args, 'name', 'network_id')
              : family === 'volume' ? summaryFirst(args, 'volume_name', 'name') : summaryValue(args.name);
      const endpoint = summaryValue(args.endpoint_id);
      return summaryJoin(label || 'run workflow', target, endpoint ? `endpoint ${endpoint}` : null);
    }
    return summaryJoin(actions[action] ?? 'manage API connection',
      action === 'capabilities' || action === 'recommend' ? summaryValue(args.category) : null,
      action === 'set' ? summaryValue(args.base_url) : null);
  },
});
