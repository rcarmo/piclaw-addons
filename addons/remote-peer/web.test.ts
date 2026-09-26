import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { remotePeerStyles } from './web/styles.ts';
const source = readFileSync(new URL("./web/index.ts", import.meta.url), "utf8");
// The registration VM has no module loader; real-host browser tests cover exact imports.
const registrationSource = source.replace('import { remotePeerStyles } from "./styles.ts";', `const remotePeerStyles = ${JSON.stringify(remotePeerStyles)};`);

describe("Remote Peer Settings registration", () => {
  test("permission editor replaces policy prompts and fields use the host shell", () => {
    expect(source).not.toContain('prompt("Allow bounded file transfers?"');
    expect(source).not.toContain('"Named aliases (comma-separated)"');
    expect(source).not.toContain('"Scope: none, inbox-only, named-agents, all-advertised"');
    expect(source).toContain('onClick=${apply}>Apply');
    expect(source).toContain('role="alert"');
    expect(source).toContain('for="remote-peer-relay-mode"');
    expect(source).not.toContain('minWidth: "180px"');
    expect(source).toContain('action: "remote_permissions"');
  });
  for (const uiKey of ["__piclawPreactHtm", "__piclawPreact"]) {
    for (const registryKey of ["__piclawSettingsPaneRegistry", "__piclaw_web"]) {
      test(`registers an SVG icon via ${uiKey} and ${registryKey}`, () => {
        const rendered: { markup: string }[] = [];
        const panes: any[] = [];
        let notifications = 0;
        runInNewContext(registrationSource, {
          [uiKey]: {
            html(strings: TemplateStringsArray) {
              const node = { markup: strings.join("") };
              rendered.push(node);
              return node;
            },
            useState() { throw new Error("Registration must not mount the pane"); },
            useEffect() { throw new Error("Registration must not start effects"); },
          },
          [registryKey]: {
            registerSettingsPane: (pane: unknown) => panes.push(pane),
            notifySettingsPanesChanged: () => notifications++,
          },
        });
        expect(panes).toHaveLength(1);
        expect(panes[0]).toMatchObject({ id: "remote-peer", label: "Remote Peer", order: 190 });
        expect(typeof panes[0].component).toBe("function");
        expect(rendered).toHaveLength(1);
        expect(panes[0].icon).toBe(rendered[0]);
        expect(rendered[0]!.markup).toContain('<svg');
        for (const attribute of ['width="16"', 'height="16"', 'viewBox="0 0 24 24"', 'stroke="currentColor"', 'fill="none"', 'aria-hidden="true"']) {
          expect(rendered[0]!.markup).toContain(attribute);
        }
        expect(rendered[0]!.markup).toMatch(/<(path|rect|circle)\b/);
        expect(notifications).toBe(registryKey === "__piclawSettingsPaneRegistry" ? 1 : 0);
      });
    }
  }

  test("does not register without the UI runtime", () => {
    const panes: unknown[] = [];
    runInNewContext(registrationSource, {
      __piclawSettingsPaneRegistry: { registerSettingsPane: (pane: unknown) => panes.push(pane) },
    });
    expect(panes).toHaveLength(0);
  });
});
