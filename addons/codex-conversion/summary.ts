import { summaryArgs, summaryValue, summaryFields, summaryFirst, summaryJoin, summaryChoice, summaryWords, summaryRequest, type ToolCallSummary } from './compat/tool-call-summary.js';
export const callSummaries: Readonly<Record<string, ToolCallSummary>> = Object.freeze({
  // Shell commands are intentionally visible; stdin bytes are never previewed.
  exec_command: input => {
    const args = summaryArgs(input);
    return typeof args.cmd === 'string' && args.cmd.trim() ? args.cmd : 'run shell command';
  },
  write_stdin: input => {
    const args = summaryArgs(input);
    return summaryJoin(typeof args.chars === 'string' && args.chars ? 'send input to session' : 'read session output', summaryValue(args.session_id));
  },
  apply_patch: input => {
    const args = summaryArgs(input);
    const files = typeof args.input === 'string' ? [...args.input.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].slice(0, 3).map(match => summaryValue(match[1])) : [];
    return summaryJoin('apply patch', files.filter(Boolean).join(', '));
  },
  web_search: () => 'search the web',
  image_generation: () => 'generate image',
  view_image: input => summaryJoin('view image', summaryValue(summaryArgs(input).path)),
});
