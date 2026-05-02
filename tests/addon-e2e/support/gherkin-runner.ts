import type { AddonStepContext } from './world';

export type StepHandler = (ctx: AddonStepContext, ...args: string[]) => Promise<void> | void;
export interface StepDefinition {
  pattern: RegExp | string;
  handler: StepHandler;
}

function stripKeyword(step: string): string {
  return step.replace(/^(Given|When|Then|And|But)\s+/i, '').trim();
}

function matchStep(def: StepDefinition, text: string): string[] | null {
  const body = stripKeyword(text);
  if (typeof def.pattern === 'string') return def.pattern === body ? [] : null;
  const match = body.match(def.pattern);
  if (!match) return null;
  return match.slice(1);
}

export function createRunner(definitions: StepDefinition[], ctx: AddonStepContext) {
  return {
    async run(step: string): Promise<void> {
      for (const def of definitions) {
        const args = matchStep(def, step);
        if (args) {
          await def.handler(ctx, ...args);
          return;
        }
      }
      throw new Error(`No add-on E2E step definition matched: ${step}`);
    },
  };
}
