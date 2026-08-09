import { afterEach, expect, test } from "bun:test";

const registrationKey = Symbol.for("@rcarmo/piclaw-addon-goal/deadline-checkpoint-registration");
let importSequence = 0;

async function importRuntime(label: string): Promise<void> {
  importSequence += 1;
  await import(`./runtime.ts?${label}-${importSequence}`);
}

afterEach(() => {
  const state = (globalThis as any)[registrationKey];
  if (typeof state?.unregister === "function") state.unregister();
  delete (globalThis as any)[registrationKey];
  delete (globalThis as any).__piclaw_runtime;
});

test("runtime registration is idempotent for duplicate startup imports", async () => {
  let registrations = 0;
  let unregisters = 0;
  let activeProvider: unknown = null;
  (globalThis as any).__piclaw_runtime = {
    registerGoalDeadlineCheckpointProvider(provider: unknown) {
      registrations += 1;
      activeProvider = provider;
      return () => {
        unregisters += 1;
        if (activeProvider === provider) activeProvider = null;
      };
    },
  };

  await importRuntime("duplicate-a");
  const firstProvider = activeProvider;
  await importRuntime("duplicate-b");

  expect(firstProvider).not.toBeNull();
  expect(activeProvider).toBe(firstProvider);
  expect(registrations).toBe(1);
  expect(unregisters).toBe(0);
});

test("runtime startup is a no-op on older cores with no registration API", async () => {
  (globalThis as any).__piclaw_runtime = {};
  await expect(importRuntime("older-core")).resolves.toBeUndefined();
  delete (globalThis as any).__piclaw_runtime;
  await expect(importRuntime("no-runtime")).resolves.toBeUndefined();
});

test("a throwing Goal checkpoint registrar fails closed without breaking startup", async () => {
  (globalThis as any).__piclaw_runtime = {
    registerGoalDeadlineCheckpointProvider() {
      throw new Error("registrar unavailable");
    },
  };
  await expect(importRuntime("throwing-registrar")).resolves.toBeUndefined();
  expect((globalThis as any)[registrationKey]).toBeUndefined();
});
