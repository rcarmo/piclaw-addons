import { expect, test } from "bun:test";

test.each([
  "open reply obligation",
  "The environment enables Telegram via PICLAW_TELEGRAM_ENABLED=1. Unset it before disabling Telegram in Settings.",
])("settings pane reloads server status after a rejected save: %s", async (error) => {
  const host = globalThis as any;
  const previousPreact = host.__piclawPreactHtm;
  const previousRegistry = host.__piclawSettingsPaneRegistry;
  const previousFetch = globalThis.fetch;
  const callbacks: Array<() => Promise<void>> = [];
  const stateChanges: Array<[number, unknown]> = [];
  const requests: string[] = [];
  let stateIndex = 0;
  let pane: (() => unknown) | undefined;
  host.__piclawPreactHtm = {
    html: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    useState: (initial: unknown) => {
      const index = stateIndex++;
      return [initial, (value: unknown) => stateChanges.push([index, value])];
    },
    useEffect: () => {},
    useCallback: (callback: () => Promise<void>) => { callbacks.push(callback); return callback; },
  };
  host.__piclawSettingsPaneRegistry = { registerSettingsPane: (definition: any) => { pane = definition.component; } };
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    requests.push(init?.method ?? "GET");
    if (init?.method === "POST") return Response.json({ error }, { status: 409 });
    return Response.json({ enabled: true, connected: false, status: "Disconnected", botTokenConfigured: true, targets: [] });
  }) as typeof fetch;
  try {
    await import(`./web/index.ts?save-error-test=${encodeURIComponent(error)}`);
    expect(pane).toBeDefined();
    const rendered = pane!() as { strings: TemplateStringsArray };
    expect(rendered.strings.join("")).toContain("Settings disable is rejected; unset that override first.");
    expect(rendered.strings.join("")).toContain("/start reports that agent access is unavailable.");
    await callbacks[1]();
    expect(requests).toEqual(["POST", "GET"]);
    expect(stateChanges).toContainEqual([2, error]);
    expect(stateChanges).toContainEqual([0, { enabled: true, connected: false, status: "Disconnected", botTokenConfigured: true, targets: [] }]);
    expect(stateChanges.at(-1)).toEqual([1, false]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousPreact === undefined) delete host.__piclawPreactHtm;
    else host.__piclawPreactHtm = previousPreact;
    if (previousRegistry === undefined) delete host.__piclawSettingsPaneRegistry;
    else host.__piclawSettingsPaneRegistry = previousRegistry;
  }
});
