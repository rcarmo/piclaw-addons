import { expect, test } from 'bun:test';
import { createGoalTools, loadThreadGoal, resetGoalAddonForTests } from './addons/goal/index.ts';
import { createPlanTool, loadSessionPlan, resetPlanSidebarAddonForTests } from './addons/plan-sidebar/index.ts';
import { createLateNightRegrets } from './addons/late-night-regrets/native.ts';

for (const reject of [false, true]) test(`native Goal and Plan await persistence before publication; reject=${reject}`, async () => {
  resetGoalAddonForTests(); resetPlanSidebarAddonForTests();
  const globals = globalThis as any, original = globals.__PICLAW_BROADCAST_EVENT__;
  const events: unknown[] = [];
  globals.__PICLAW_BROADCAST_EVENT__ = (...args: unknown[]) => events.push(args);
  let release!: () => void;
  let gate = new Promise<void>(resolve => { release = resolve; });
  const write = async <T>(body: () => T): Promise<T> => { await gate; if (reject) throw Error('write denied'); return body(); };
  try {
    const goal = createGoalTools(() => 'web:async-goal', { write }).find(tool => tool.name === 'create_goal')!;
    const pending = goal.execute('goal', { objective: 'synthetic owned goal' } as any, undefined, undefined, {} as any);
    await Bun.sleep(0);
    expect(loadThreadGoal('web:async-goal')).toBeNull(); expect(events).toHaveLength(0);
    release();
    if (reject) await expect(pending).rejects.toThrow('write denied'); else await pending;
    expect(loadThreadGoal('web:async-goal') !== null).toBe(!reject); expect(events).toHaveLength(reject ? 0 : 1);
    const count = events.length;
    gate = new Promise<void>(resolve => { release = resolve; });
    const plan = createPlanTool(write);
    const before = loadSessionPlan('web:async-plan').markdown;
    const updated = plan.execute('plan', { action: 'write', chat_jid: 'web:async-plan', markdown: '- [ ] synthetic' } as any, undefined, undefined, {} as any);
    await Bun.sleep(0);
    expect(loadSessionPlan('web:async-plan').markdown).toBe(before); expect(events).toHaveLength(count);
    release();
    if (reject) await expect(updated).rejects.toThrow('write denied'); else await updated;
    expect(loadSessionPlan('web:async-plan').markdown).toBe(reject ? before : '- [ ] synthetic');
  } finally { release(); globals.__PICLAW_BROADCAST_EVENT__ = original; }
});

test('native Regrets acknowledges an asynchronous config write only after completion', async () => {
  let release!: () => void, saved = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const api = createLateNightRegrets({ chat: 'fixture', cwd: '/fixture', assertCurrent() {}, assertSingleUser() {},
    config: { get: () => ({}), async set() { await gate; saved = true; } }, history: async () => ({ exchanges: [], excluded: {} }),
    readFile: async () => undefined, accountedDecision: { getAvailable: () => [], complete: async () => { throw Error('unused'); } }, admitConversationInput: async () => {},
  });
  let acknowledged = false;
  const pending = api.setConfig({ enabled: false }).then(result => { acknowledged = true; return result; });
  await Bun.sleep(0); expect(saved).toBe(false); expect(acknowledged).toBe(false);
  release(); expect(await pending).toHaveProperty('ok', true); expect(saved).toBe(true);
});
