import { summaryArgs, summaryValue, summaryFields, summaryFirst, summaryJoin, summaryChoice, summaryWords, summaryRequest, type ToolCallSummary } from './compat/tool-call-summary.js';
const actions: Readonly<Record<string, string>> = Object.freeze({
  help: 'show device help', capabilities: 'list device capabilities', 'profile.list': 'list profiles', 'profile.select': 'select profile',
  status: 'show device status', snapshot: 'capture device screen', 'key.tap': 'tap key', 'key.combo': 'send key combination', 'key.repeat': 'repeat key',
  text: 'type text', 'mouse.move': 'move pointer', 'mouse.click': 'click pointer', 'mouse.drag': 'drag pointer', 'mouse.scroll': 'scroll pointer',
  'input.batch': 'send input batch', 'input.release': 'release input', 'job.start': 'start device job', 'job.status': 'show device job status', 'job.cancel': 'cancel device job',
  'reboot.plan': 'plan reboot', 'firmware.entry.plan': 'plan firmware entry', 'power.status': 'read power status', 'power.press': 'press power button', 'power.reset': 'reset power', 'power.cycle': 'cycle power',
  'media.list': 'list media', 'media.mount': 'mount media', 'media.eject': 'eject media', 'device.reboot': 'reboot device',
});
export const callSummaries: Readonly<Record<string, ToolCallSummary>> = Object.freeze({
  linkr(input) {
    const args = summaryArgs(input), action = summaryChoice(args.action, Object.keys(actions).join(' '));
    return summaryJoin(actions[action] ?? 'control device', summaryFields(args, 'device_id', 'job_id'));
  },
});
