type Launch = { project_dir: string; prompt: string; chat_jid: string; max_iterations?: number; variables?: string[]; sandbox?: boolean };
type Model = { label: string; contextWindow?: number };
type LaunchRequest = Launch & { model: string; sandbox: boolean };

export type AutoresearchLaunchPost = (input: {
  chatJid: string;
  fallback: string;
  express: string;
  actions: { launch(context: { chatJid: string; values: Readonly<Record<string, unknown>>; assertCurrent?: () => void; sendMessage(content: string): Promise<void> }): Promise<void> };
}, signal?: AbortSignal) => Promise<number>;

function formatContextWindow(value: number | undefined): string {
  if (!value || !Number.isFinite(value) || value < 0) return 'unknown ctx';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 ? 1 : 0)}M ctx`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value % 1_000 ? 1 : 0)}k ctx`;
  return `${value} ctx`;
}

export async function postAutoresearchLaunch(launch: Launch, models: Model[], currentModel: string | null,
  start: (params: LaunchRequest, assertCurrent?: () => void) => Promise<string>, signal?: AbortSignal,
  nativePost?: AutoresearchLaunchPost): Promise<number> {
  const runtime = (globalThis as { __piclaw_runtime?: { a2ui?: { version: number; post: AutoresearchLaunchPost } } }).__piclaw_runtime;
  const post = nativePost ?? (runtime?.a2ui?.version === 1 ? runtime.a2ui.post : undefined);
  if (!post) throw Error('The A2UI post API is unavailable');
  const exact = models.find(model => model.label === currentModel);
  const choices = [...new Map([...(exact ? [exact] : []), ...models].map(model => [model.label, model])).values()].slice(0, 80);
  if (!choices.length) throw Error('No model choices');
  const allowed = new Set(choices.map(model => model.label));
  const options = choices.map(model => ({ value: model.label, label: `${model.label} • ${formatContextWindow(model.contextWindow)}` }));
  // JSON string literals and maps are Express literals. No user value is interpolated as DSL.
  const lines = [
    `$/model = ${JSON.stringify([choices[0].label])}; $/sandbox = ${launch.sandbox !== false};`,
    `root = Column([Text("Autoresearch — Launch Experiment"),`,
    `Text(${JSON.stringify(launch.prompt.slice(0, 1600))}),`,
    `Text(${JSON.stringify(`Project: ${launch.project_dir.slice(0, 512)}`)}),`,
    `Text(${JSON.stringify(`Runs: ${launch.max_iterations ? `Up to ${launch.max_iterations}` : 'Open-ended'}`)}),`,
    `Text(${JSON.stringify(`Variables: ${launch.variables?.join(', ').slice(0, 512) || 'Auto-detect during run'}`)}),`,
    `ChoicePicker(label="Model", options=${JSON.stringify(options)}, value=$/model),`,
    'CheckBox(label="Run in a copied sandbox (uses more disk)", value=$/sandbox),',
    'Text("When off, runs in a fresh git worktree on a new branch in the same repo. Requires a Git repository.", variant="caption"),',
    'Button(child=Text("Launch Experiment →"), variant="primary", action=Event("launch", {model: $/model, sandbox: $/sandbox}))])',
  ];
  const captured = structuredClone(launch);
  return post({ chatJid: captured.chat_jid, fallback: 'Configure and launch the Autoresearch experiment.', express: lines.join('\n'),
    actions: { async launch({ chatJid, values, assertCurrent, sendMessage }) {
      const model = Array.isArray(values.model) && values.model.length === 1 ? values.model[0] : undefined;
      if (chatJid !== captured.chat_jid || typeof model !== 'string' || !allowed.has(model) || typeof values.sandbox !== 'boolean') {
        throw Error('Invalid experiment selection');
      }
      if (nativePost && !assertCurrent) throw Error('Native surface action authority required');
      assertCurrent?.();
      await sendMessage(`Launching with model **${model}**…`);
      assertCurrent?.();
      const result = await start({ ...captured, model, sandbox: values.sandbox }, assertCurrent);
      assertCurrent?.();
      await sendMessage(result);
    } },
  }, signal);
}
