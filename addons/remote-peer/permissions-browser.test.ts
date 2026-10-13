import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { settingsBrowserEnabled, settingsPaneFixture } from "../../scripts/lib/settings-pane-browser.js";
const browserTest = settingsBrowserEnabled ? test : test.skip;
let fixture: Awaited<ReturnType<typeof settingsPaneFixture>>;
beforeAll(async () => { if (settingsBrowserEnabled) fixture = await settingsPaneFixture(new URL("./web/index.ts", import.meta.url).pathname, { realHost: true }); }, 30000);
afterAll(async () => { await fixture?.close(); });

async function setup(skin: string, width: number, options: { long?: boolean; sessions?: boolean; colorScheme?: 'light' | 'dark' } = {}) {
  const f = await fixture.page(skin, width, options.colorScheme ?? 'light');
  const peer = (id: string, alias: string) => ({ id, alias, name: alias, clientId: "PCL1-" + id, status: "paired", epoch: "epoch", scope: "named-agents", agents: ["research", "hidden"], modes: ["queue", "auto"], files: false });
  const data: any = { config: { enabled: true, instanceName: "Test", relays: [], relayMode: "disabled", mdnsEnabled: false, addressLookup: false }, identity: { clientId: "PCL1-local" }, transport: { active: true }, discovery: { active: false }, peers: [peer("first", "Lab"), peer("second", "Other")], advertised: [{ alias: "research", local_agent: "research" }], candidates: [], messages: [], work: [], localAgents: [] };
  if (options.long) {
    const id = 'PCL1-' + '0123456789abcdef'.repeat(12);
    data.identity.clientId = id;
    data.peers[0].clientId = id;
    data.peers[0].alias = 'Research ' + 'very-long-name-'.repeat(6);
    data.peers[0].name = 'Same long instance ' + 'label'.repeat(12);
    data.peers.push({ ...data.peers[1], id: 'incoming', epoch: 'pending', alias: 'Pending peer', status: 'incoming', clientId: id });
    data.candidates = [{name:'Nearby test device',clientId:id}];
    data.messages = [{id:'message-'+'a'.repeat(160),status:'failed',error:'Offline '+ 'error-detail'.repeat(15)}];
    data.work = [{id:'work-'+'b'.repeat(160),direction:'inbound',status:'pending',data:{prompt:'Untrusted sample request '+ 'long-line'.repeat(60)}}];
    data.transport.error = 'Fixture transport error: '+ 'address'.repeat(40);
  }
  if (options.sessions) {
    data.advertised_sessions = [{ agent: "research", session_alias: "review", local_agent: "research", chat_jid: "branch-1", incarnation: "life-1", revision: "advertisement-A", modes: '["queue","steer"]', status: "ready" }];
    data.peers[0].sessions = [];
  }
  const writes: any[] = [];
  const failure = { post: false, get: false, remote: false, hold: null as null | Promise<void>, remoteCalls: 0, beforeWrite: null as null | (() => void), targets: false, staleTarget: false };
  await f.page.route("**/agent/addons/api/remote-peer/dashboard", async (route: any) => {
    const body = route.request().method() === "POST" ? route.request().postDataJSON() : null;
    if (body?.action === "session_targets") {
      if (failure.targets) return route.fulfill({ status: 503, json: { error: "Authenticated peer incarnation-bound admission API unavailable." } });
      return route.fulfill({ json: { ...data, result: [{ chatJid: "branch-1", incarnation: "life-1", agentName: "research", active: false }] } });
    }
    if (body?.action === "session_advertise" || body?.action === "session_unadvertise") {
      writes.push(body);
      if (body.action === "session_advertise" && failure.staleTarget) return route.fulfill({ status: 400, json: { error: "Session lifetime is stale or unavailable." } });
      if (body.action === "session_advertise") data.advertised_sessions = [{ agent: body.agent, session_alias: body.session_alias, chat_jid: body.chat_jid, incarnation: body.incarnation, revision: "advertisement-new-" + writes.length, local_agent: "research", modes: JSON.stringify(body.modes), status: "ready" }];
      else {
        data.advertised_sessions = [];
        data.peers[0].sessions = [];
      }
      // Each advertisement, even for the same lifetime, revokes previous grants.
      if (body.action === "session_advertise") data.peers[0].sessions = [];
      return route.fulfill({ json: data });
    }
    if (body?.action === "remote_permissions") {
      failure.remoteCalls++;
      if (failure.remote) return route.fulfill({ status: 503, json: { error: "Peer offline" } });
      return route.fulfill({ json: { ...data, result: { peerId: body.peer, fetchedAt: new Date().toISOString(), inbox: true, agents: [], sessions: options.sessions ? [{ agent: "research", session_alias: "review", modes: ["queue"], status: "unreachable" }] : [], modes: ["queue"], files: false, limits: { maxFiles: 4, maxFileBytes: 16777216, maxTotalBytes: 33554432 } } } });
    }
    if (body) {
      writes.push(body);
      if (failure.hold) await failure.hold;
      if (failure.post) return route.fulfill({ status: 400, json: { error: "Permission write rejected" } });
      expect(body.action).toBe("policy");
      expect(body.confirmation).toBe("ALLOW REMOTE ACCESS");
      failure.beforeWrite?.();
      const p = data.peers.find(p => p.id === body.peer)!;
      const policy = (p: any) => JSON.stringify([p.scope, p.modes, p.agents, p.files, p.sessions ?? []]);
      if (p.epoch !== body.expected_epoch || policy(p) !== policy(body.expected_policy))
        return route.fulfill({ status: 409, json: { error: "Saved permissions or pairing changed. Revert to reload before applying." } });
      for (const grant of body.sessions ?? []) {
        const advertisement = data.advertised_sessions?.find(s => s.agent === grant.agent && s.session_alias === grant.session_alias);
        if (!grant.revision || grant.revision !== advertisement?.revision)
          return route.fulfill({ status: 409, json: { error: "Session advertisement changed. Revert and select the current session before applying." } });
      }
      Object.assign(p, { scope: body.scope, modes: body.modes, agents: body.agents, files: body.files, ...(body.sessions === undefined ? {} : { sessions: body.sessions }) });
    } else if (failure.get) return route.fulfill({ status: 503, json: { error: "Readback failed" } });
    return route.fulfill({ json: data });
  });
  await f.page.goto(f.url);
  const card = f.page.locator('[data-peer-id="first"]');
  await card.getByRole("button", { name: "Edit incoming permissions" }).waitFor();
  return { ...f, card, data, writes, failure };
}

for (const skin of ["classic", "visual", "legacy"]) for (const width of [1366, 820, 520, 390]) {
  browserTest(`Remote Peer ${skin}/${width} incoming file-only Apply/Cancel/Revert and outgoing ownership`, async () => {
    const f = await setup(skin, width), { page, card } = f;
    try {
      expect(f.failure.remoteCalls).toBe(0);
      // Every text/select/multiline field opts into the host's same-skin shell.
      for (const label of ["Instance name", "Peer client ID", "Peer alias", "IPv4 interface (optional)", "Advertise a local agent", "Relay mode", "Custom relays (JSON)"]) {
        const field = page.getByLabel(label, { exact: true });
        expect(await field.getAttribute("class")).toContain("settings-addon-control");
        const geometry = await field.evaluate((el: HTMLElement) => {
          const s = getComputedStyle(el), r = el.getBoundingClientRect(), parent = el.parentElement!.getBoundingClientRect();
          return { radius: s.borderRadius, padding: s.padding, border: s.borderTopWidth, fits: r.right <= parent.right + 1 && r.left >= parent.left - 1 };
        });
        expect(geometry).toEqual({ radius: skin === "visual" ? "3px" : "6px", padding: skin === "visual" ? "5px 10px" : "6px 10px", border: "1px", fits: true });
      }
      expect(await page.locator(".remote-peer-settings").evaluate((el: HTMLElement) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      await card.getByRole("button", { name: "Edit incoming permissions" }).click();
      const files = card.getByRole("checkbox", { name: "Allow this peer to send files here" });
      await card.getByRole("checkbox", { name: "queue", exact: true }).uncheck();
      await card.getByRole("checkbox", { name: "auto", exact: true }).uncheck();
      expect(await card.getByRole("button", { name: "Apply", exact: true }).isDisabled()).toBe(true);
      await card.getByRole("button", { name: "Revert", exact: true }).click();
      await files.check();
      expect(await card.getByRole("button", { name: "Apply", exact: true }).isDisabled()).toBe(true);
      await card.getByLabel("Confirm wider incoming access").fill("WRONG");
      expect(await card.getByRole("button", { name: "Apply", exact: true }).isDisabled()).toBe(true);
      await card.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(f.writes).toEqual([]);
      await card.getByRole("button", { name: "Edit incoming permissions" }).click();
      expect(await files.isChecked()).toBe(false);
      await files.check();
      await card.getByRole("button", { name: "Revert", exact: true }).click();
      expect(await files.isChecked()).toBe(false);
      await files.check();
      await card.getByLabel("Confirm wider incoming access").fill("ALLOW REMOTE ACCESS");
      expect(await card.locator(".remote-peer-permissions").evaluate((el: HTMLElement) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      const evidence = process.env.PICLAW_REMOTE_PEER_SCREENSHOT_DIR;
      if (evidence && skin !== "legacy" && [1366, 390].includes(width)) {
        if (!isAbsolute(evidence)) throw Error("Screenshot output must be an explicit absolute directory");
        mkdirSync(evidence, { recursive: true });
        await card.locator(".remote-peer-permissions").screenshot({ path: join(evidence, `permissions-${skin}-${width}.png`) });
      }
      await card.getByRole("button", { name: "Apply", exact: true }).click();
      await card.getByText(/Incoming permissions saved and reloaded/).waitFor();
      expect(f.writes).toEqual([{ action: "policy", peer: "first", scope: "named-agents", modes: ["queue", "auto"], agents: ["research", "hidden"], files: true, confirmation: "ALLOW REMOTE ACCESS", expected_epoch: "epoch", expected_policy: { scope: "named-agents", modes: ["queue", "auto"], agents: ["research", "hidden"], files: false } }]);
      expect(f.data.peers[1].files).toBe(false);
      await page.reload();
      await card.getByText(/Saved: named-agents · queue, auto · incoming files enabled/).waitFor();
      await card.getByRole("button", { name: "Refresh remote permissions" }).click();
      await card.getByText(/outgoing files disabled/).waitFor();
      expect(f.data.peers[0].files).toBe(true);
      f.failure.remote = true;
      await card.getByRole("button", { name: "Refresh remote permissions" }).click();
      await card.getByRole("alert").filter({ hasText: "Peer offline" }).waitFor();
      expect(await card.getByText(/Last fetched snapshot is stale/).isVisible()).toBe(true);
      const outgoing = card.getByRole("region", { name: "Outgoing permissions", exact: true });
      expect(await outgoing.locator("input,select,textarea").count()).toBe(0);
      await card.getByRole("button", { name: "Edit incoming permissions" }).click();
      await files.uncheck();
      await card.getByLabel("Confirm wider incoming access").fill("ALLOW REMOTE ACCESS");
      await card.getByRole("button", { name: "Apply", exact: true }).click();
      await card.getByText(/Incoming permissions saved and reloaded/).waitFor();
      expect(f.writes[1]).toEqual({ ...f.writes[0], files: false, expected_policy: { ...f.writes[0].expected_policy, files: true } });
      expect(f.errors).toEqual([]);
    } finally { await page.close(); }
  }, 20000);
}

browserTest("Remote Peer preserves edits on server error, disables double Apply and verifies readback", async () => {
  const f = await setup("classic", 1100), { page, card } = f;
  try {
    await card.getByRole("button", { name: "Edit incoming permissions" }).click();
    const files = card.getByRole("checkbox", { name: "Allow this peer to send files here" });
    await files.check();
    await card.getByLabel("Confirm wider incoming access").fill("ALLOW REMOTE ACCESS");
    f.failure.post = true;
    let release!: () => void;
    f.failure.hold = new Promise<void>(resolve => { release = resolve; });
    await card.getByRole("button", { name: "Apply", exact: true }).click();
    await card.getByText("Applying incoming permissions…", { exact: true }).waitFor();
    expect(await card.getByRole("button", { name: "Apply", exact: true }).isDisabled()).toBe(true);
    release();
    await card.getByRole("alert").filter({ hasText: "Permission write rejected" }).waitFor();
    expect(await files.isChecked()).toBe(true);
    expect(f.writes).toHaveLength(1);
    expect(f.data.peers[0].files).toBe(false);
    f.failure.post = false; f.failure.hold = null; f.failure.get = true;
    await card.getByRole("button", { name: "Apply", exact: true }).click();
    await card.getByRole("alert").filter({ hasText: "Readback failed" }).waitFor();
    expect(await card.getByText(/Incoming permissions saved and reloaded/).count()).toBe(0);
    expect(await files.isChecked()).toBe(true);
    f.failure.get = false;
    await card.getByRole("button", { name: "Apply", exact: true }).click();
    await card.getByRole("alert").filter({ hasText: "Saved permissions or pairing changed" }).waitFor();
    expect(await files.isChecked()).toBe(true);
    expect(f.data.peers[0].files).toBe(true);
    expect(f.errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);

browserTest("dashboard polling preserves unsaved edits and reports saved-policy conflicts", async () => {
  const f = await setup("classic", 1100), { page, card } = f;
  try {
    await card.getByRole("button", { name: "Edit incoming permissions" }).click();
    const files = card.getByRole("checkbox", { name: "Allow this peer to send files here" });
    await files.check();
    await card.getByLabel("Confirm wider incoming access").fill("ALLOW REMOTE ACCESS");
    f.data.peers[0].modes = ["queue"];
    await card.getByRole("alert").filter({ hasText: "Saved permissions changed while you were editing" }).waitFor({ timeout: 8000 });
    expect(await files.isChecked()).toBe(true);
    expect(await card.getByRole("button", { name: "Apply", exact: true }).isDisabled()).toBe(true);
    expect(f.writes).toEqual([]);
    await card.getByRole("button", { name: "Revert", exact: true }).click();
    expect(await files.isChecked()).toBe(false);
    expect(await card.getByRole("checkbox", { name: "auto", exact: true }).isChecked()).toBe(false);
    expect(f.errors).toEqual([]);
  } finally { await page.close(); }
}, 15000);

for (const race of ["narrow", "re-pair"]) browserTest(`Apply rejects ${race} between poll and write without losing draft`, async () => {
  const f = await setup("classic", 1100), { page, card } = f;
  try {
    await card.getByRole("button", { name: "Edit incoming permissions" }).click();
    const files = card.getByRole("checkbox", { name: "Allow this peer to send files here" });
    await files.check();
    await card.getByLabel("Confirm wider incoming access").fill("ALLOW REMOTE ACCESS");
    f.failure.beforeWrite = () => {
      if (race === "narrow") Object.assign(f.data.peers[0], { scope: "inbox-only", modes: ["queue"], agents: [] });
      else f.data.peers[0].epoch = "new-pair";
    };
    await card.getByRole("button", { name: "Apply", exact: true }).click();
    await card.getByRole("alert").filter({ hasText: "Saved permissions or pairing changed" }).waitFor();
    expect(f.data.peers[0].files).toBe(false);
    expect(await files.isChecked()).toBe(true);
    expect(await card.getByText(/Incoming permissions saved and reloaded/).count()).toBe(0);
    if (race === "narrow") expect(f.data.peers[0].scope).toBe("inbox-only");
    expect(f.errors).toEqual([]);
  } finally { await page.close(); }
}, 15000);

for (const skin of ["classic", "visual", "legacy"]) browserTest(`Remote Peer ${skin} explicit session grants, consent, revocation and outgoing status`, async () => {
  const f = await setup(skin, 390, { sessions: true }), { page, card } = f;
  try {
    await card.getByRole("button", { name: "Edit incoming permissions" }).click();
    await card.getByLabel("Incoming scope", { exact: true }).selectOption("all-advertised");
    const grant = card.getByLabel("Allow session @research/review", { exact: true });
    expect(await grant.isChecked()).toBe(false);
    await grant.check();
    await card.getByLabel("Session @research/review queue", { exact: true }).uncheck();
    await card.getByLabel("Confirm wider incoming access").fill("ALLOW REMOTE ACCESS");
    expect(await card.getByRole("button", { name: "Apply", exact: true }).isDisabled()).toBe(true);
    await card.getByLabel("Session @research/review steer", { exact: true }).check();
    // Changing the draft invalidates typed consent.
    expect(await card.getByLabel("Confirm wider incoming access").inputValue()).toBe("");
    await card.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(f.writes).toEqual([]);
    await card.getByRole("button", { name: "Edit incoming permissions" }).click();
    expect(await grant.isChecked()).toBe(false);
    await grant.check();
    await card.getByRole("button", { name: "Revert", exact: true }).click();
    expect(await grant.isChecked()).toBe(false);
    await grant.check();
    await card.getByLabel("Confirm wider incoming access").fill("WRONG");
    expect(await card.getByRole("button", { name: "Apply", exact: true }).isDisabled()).toBe(true);
    await card.getByLabel("Confirm wider incoming access").fill("ALLOW REMOTE ACCESS");
    await card.getByRole("button", { name: "Apply", exact: true }).click();
    await card.getByText(/Incoming permissions saved and reloaded/).waitFor();
    expect(f.writes[0].sessions).toEqual([{ agent: "research", session_alias: "review", revision: "advertisement-A", modes: ["queue"] }]);
    expect(f.writes[0].expected_policy.sessions).toEqual([]);
    expect(f.writes[0].agents).toEqual(["research", "hidden"]);
    expect(f.data.peers[1].sessions).toBeUndefined();
    await card.getByRole("button", { name: "Refresh remote permissions" }).click();
    await card.getByText("Advertised remote sessions: @research/review (queue) — unreachable", { exact: true }).waitFor();
    expect(await card.getByRole("region", { name: "Outgoing permissions" }).locator("input,select,textarea").count()).toBe(0);
    await card.getByRole("button", { name: "Edit incoming permissions" }).click();
    await grant.uncheck();
    await card.getByLabel("Confirm wider incoming access").fill("ALLOW REMOTE ACCESS");
    await card.getByRole("button", { name: "Apply", exact: true }).click();
    await card.getByText(/Incoming permissions saved and reloaded/).waitFor();
    expect(f.writes[1].sessions).toEqual([]);
    expect(f.writes[1].expected_policy.sessions).toEqual(f.writes[0].sessions);
    expect(f.errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);

for (const skin of ["classic", "visual"]) browserTest(`Remote Peer ${skin} keyboard session consent and file-only preservation`, async () => {
  const f = await setup(skin, 390, { sessions: true }), { page, card } = f;
  try {
    f.data.peers[0].scope = "inbox-only"; f.data.peers[0].modes = ["queue"];
    await page.reload();
    await card.getByRole("button", { name: "Edit incoming permissions" }).click();
    const grant = card.getByLabel("Allow session @research/review", { exact: true });
    await grant.focus(); await page.keyboard.press("Space");
    expect(await grant.isChecked()).toBe(true);
    expect(await card.getByRole("button", { name: "Apply", exact: true }).isDisabled()).toBe(true);
    await card.getByLabel("Confirm wider incoming access").fill("ALLOW REMOTE ACCESS");
    await card.getByRole("button", { name: "Apply", exact: true }).focus(); await page.keyboard.press("Enter");
    await card.getByText(/Incoming permissions saved and reloaded/).waitFor();
    expect(f.writes[0].sessions).toEqual([{ agent: "research", session_alias: "review", revision: "advertisement-A", modes: ["queue"] }]);
    await card.getByRole("button", { name: "Edit incoming permissions" }).click();
    await card.getByRole("checkbox", { name: "Allow this peer to send files here" }).check();
    await card.getByLabel("Confirm wider incoming access").fill("ALLOW REMOTE ACCESS");
    await card.getByRole("button", { name: "Apply", exact: true }).click();
    await card.getByText(/Incoming permissions saved and reloaded/).waitFor();
    expect(f.writes[1].sessions).toEqual(f.writes[0].sessions);
    expect(f.writes[1].agents).toEqual(f.writes[0].agents);
    expect(f.writes[1].modes).toEqual(f.writes[0].modes);
    expect(f.writes[1].scope).toBe("inbox-only");
    expect(f.writes[1].files).toBe(true);
    expect(f.errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);

browserTest("Session grant drafts retain failed edits and detect concurrent revocation", async () => {
  const f = await setup("classic", 390, { sessions: true }), { page, card } = f;
  try {
    f.data.peers[0].sessions = [{ agent: "research", session_alias: "review", revision: "advertisement-A", modes: ["queue"] }];
    await page.reload();
    await card.getByRole("button", { name: "Edit incoming permissions" }).click();
    const steer = card.getByLabel("Session @research/review steer", { exact: true });
    await steer.check();
    await card.getByLabel("Confirm wider incoming access").fill("ALLOW REMOTE ACCESS");
    f.failure.post = true;
    await card.getByRole("button", { name: "Apply", exact: true }).click();
    await card.getByRole("alert").filter({ hasText: "Permission write rejected" }).waitFor();
    expect(await steer.isChecked()).toBe(true);
    f.data.peers[0].sessions = [];
    await card.getByRole("alert").filter({ hasText: "Saved permissions changed while you were editing" }).waitFor({ timeout: 8000 });
    expect(await steer.isChecked()).toBe(true);
    expect(await card.getByRole("button", { name: "Apply", exact: true }).isDisabled()).toBe(true);
    await card.getByRole("button", { name: "Revert", exact: true }).click();
    expect(await card.getByLabel("Allow session @research/review", { exact: true }).isChecked()).toBe(false);
    expect(f.errors).toEqual([]);
  } finally { await page.close(); }
}, 15000);

for (const skin of ["classic", "visual", "legacy"]) browserTest(`Remote Peer ${skin} explicit idle advertisement and old-host unavailable`, async () => {
  const f = await setup(skin, 390, { sessions: true }), { page } = f;
  try {
    const region = page.getByRole("region", { name: "Session advertisements" });
    expect(await region.getByRole("button", { name: "Advertise session", exact: true }).isDisabled()).toBe(true);
    await region.getByRole("button", { name: "Refresh local session targets" }).click();
    await region.getByLabel("Local session target").selectOption({ label: "research · branch-1 · idle" });
    await region.getByLabel("Advertised agent alias").selectOption("research");
    await region.getByLabel("Public session alias").fill("review");
    f.failure.staleTarget = true;
    await region.getByRole("button", { name: "Advertise session", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Session lifetime is stale or unavailable." }).waitFor();
    expect(f.writes.map(w => w.action)).toEqual(["session_advertise"]);
    expect(await region.getByLabel("Public session alias").inputValue()).toBe("review");
    f.failure.staleTarget = false;
    f.writes.length = 0;
    await region.getByRole("button", { name: "Advertise session", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('button[aria-label="Hide session @research/review"]')?.hasAttribute("disabled"));
    expect(f.writes[0]).toEqual({ action: "session_advertise", agent: "research", session_alias: "review", chat_jid: "branch-1", incarnation: "life-1", modes: ["queue"] });
    await region.getByRole("button", { name: "Hide session @research/review" }).click();
    await region.getByText("No local sessions advertised.").waitFor();
    expect(f.writes[1]).toEqual({ action: "session_unadvertise", agent: "research", session_alias: "review" });
    expect(f.data.peers[0].sessions).toEqual([]);
    expect(await region.evaluate((el: HTMLElement) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    f.failure.targets = true;
    await region.getByRole("button", { name: "Refresh local session targets" }).click();
    await region.getByRole("alert").filter({ hasText: "admission API unavailable" }).waitFor();
    expect(await region.getByRole("button", { name: "Advertise session", exact: true }).isDisabled()).toBe(true);
    expect(await page.getByLabel("Advertise a local agent", { exact: true }).isEnabled()).toBe(true);
    expect(f.errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);

for (const skin of ["classic", "visual", "legacy"]) for (const timing of ["poll", "write"]) browserTest(`Remote Peer ${skin} rejects stale no-grants session consent at ${timing} and requires fresh selection`, async () => {
  const f = await setup(skin, 390, { sessions: true }), { page, card } = f;
  try {
    f.data.peers[0].scope = "inbox-only"; f.data.peers[0].modes = ["queue"];
    await page.reload();
    const before = structuredClone(f.data.peers[0]);
    await card.getByRole("button", { name: "Edit incoming permissions" }).click();
    const grant = card.getByLabel("Allow session @research/review", { exact: true });
    await grant.check();
    await card.getByLabel("Confirm wider incoming access").fill("ALLOW REMOTE ACCESS");
    const replace = () => Object.assign(f.data.advertised_sessions[0], { chat_jid: "branch-B", incarnation: "life-B", revision: "advertisement-B" });
    if (timing === "poll") {
      replace();
      await card.getByRole("alert").filter({ hasText: "Session advertisement changed while you were editing" }).waitFor({ timeout: 8000 });
      expect(f.writes).toEqual([]);
    } else {
      f.failure.beforeWrite = replace;
      await card.getByRole("button", { name: "Apply", exact: true }).click();
      await card.getByRole("alert").filter({ hasText: "Session advertisement changed. Revert" }).waitFor();
      expect(f.writes).toHaveLength(1);
      expect(f.writes[0].sessions[0].revision).toBe("advertisement-A");
    }
    expect(f.data.peers[0]).toEqual(before);
    expect(await grant.isChecked()).toBe(true); // Draft retained, never rebound.
    expect(await card.getByLabel("Confirm wider incoming access").inputValue()).toBe("");
    expect(await card.getByRole("button", { name: "Apply", exact: true }).isDisabled()).toBe(true);
    // Retyping or adjusting a stale grant must not silently recreate it.
    await card.getByLabel("Confirm wider incoming access").fill("ALLOW REMOTE ACCESS");
    await card.getByLabel("Session @research/review steer", { exact: true }).check();
    expect(await card.getByRole("button", { name: "Apply", exact: true }).isDisabled()).toBe(true);
    f.failure.beforeWrite = null;
    await card.getByRole("button", { name: "Revert", exact: true }).click();
    expect(await grant.isChecked()).toBe(false);
    // At write timing, wait for the existing dashboard poll to load B.
    if (timing === "write") await page.waitForTimeout(5500);
    await grant.check();
    expect(await card.getByLabel("Confirm wider incoming access").inputValue()).toBe("");
    expect(await card.getByRole("button", { name: "Apply", exact: true }).isDisabled()).toBe(true);
    await card.getByLabel("Confirm wider incoming access").fill("ALLOW REMOTE ACCESS");
    await card.getByRole("button", { name: "Apply", exact: true }).click();
    await card.getByText(/Incoming permissions saved and reloaded/).waitFor();
    expect(f.writes.at(-1).sessions).toEqual([{ agent: "research", session_alias: "review", revision: "advertisement-B", modes: ["queue"] }]);
    expect(f.data.peers[0].sessions).toEqual(f.writes.at(-1).sessions);
    expect(f.errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);

for (const skin of ["classic", "visual", "legacy"]) for (const lifecycle of ["hide-and-readvertise", "readvertise"]) browserTest(`Remote Peer ${skin} ${lifecycle} invalidates typed consent for the same lifetime`, async () => {
  const f = await setup(skin, 390, { sessions: true }), { page, card } = f;
  try {
    f.data.peers[0].scope = "inbox-only"; f.data.peers[0].modes = ["queue"];
    await page.reload();
    const before = structuredClone(f.data.peers[0]);
    const original = structuredClone(f.data.advertised_sessions[0]);
    const region = page.getByRole("region", { name: "Session advertisements" });
    await region.getByRole("button", { name: "Refresh local session targets" }).click();
    await region.getByLabel("Local session target").selectOption({ label: "research · branch-1 · idle" });
    await region.getByLabel("Advertised agent alias").selectOption("research");
    await region.getByLabel("Public session alias").fill("review");
    await card.getByRole("button", { name: "Edit incoming permissions" }).click();
    const grant = card.getByLabel("Allow session @research/review", { exact: true });
    const confirm = card.getByLabel("Confirm wider incoming access");
    const apply = card.getByRole("button", { name: "Apply", exact: true });
    await grant.check();
    await confirm.fill("ALLOW REMOTE ACCESS");
    expect(await apply.isEnabled()).toBe(true);
    if (lifecycle === "hide-and-readvertise") {
      await region.getByRole("button", { name: "Hide session @research/review" }).click();
      await region.getByText("No local sessions advertised.").waitFor();
      await card.getByRole("alert").filter({ hasText: "Session advertisement changed while you were editing" }).waitFor();
      expect(await confirm.inputValue()).toBe("");
      expect(await apply.isDisabled()).toBe(true);
    }
    await region.getByRole("button", { name: "Advertise session", exact: true }).click();
    await region.getByRole("button", { name: "Hide session @research/review" }).waitFor();
    await card.getByRole("alert").filter({ hasText: "Session advertisement changed while you were editing" }).waitFor();
    const current = f.data.advertised_sessions[0];
    expect(current.revision).not.toBe(original.revision);
    expect([current.chat_jid, current.incarnation]).toEqual([original.chat_jid, original.incarnation]);
    expect(f.data.peers[0]).toEqual(before); // No grants or epoch/policy changes to explain the conflict.
    expect(await confirm.inputValue()).toBe("");
    expect(await grant.isChecked()).toBe(true);
    expect(await apply.isDisabled()).toBe(true);
    // Reselecting and retyping without Revert must not bypass the latched conflict.
    await grant.uncheck(); await grant.check();
    await confirm.fill("ALLOW REMOTE ACCESS");
    expect(await apply.isDisabled()).toBe(true);
    expect(f.writes.filter(w => w.action === "policy")).toEqual([]);
    await card.getByRole("button", { name: "Revert", exact: true }).click();
    expect(await grant.isChecked()).toBe(false);
    await grant.focus(); await page.keyboard.press("Space");
    expect(await confirm.inputValue()).toBe("");
    expect(await apply.isDisabled()).toBe(true);
    await confirm.fill("ALLOW REMOTE ACCESS");
    await apply.focus(); await page.keyboard.press("Enter");
    await card.getByText(/Incoming permissions saved and reloaded/).waitFor();
    expect(f.writes.at(-1).sessions).toEqual([{ agent: "research", session_alias: "review", revision: current.revision, modes: ["queue"] }]);
    expect(f.errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);

for (const skin of ['classic','visual']) for (const colorScheme of ['light','dark'] as const) for (const width of [1366,820,390]) {
  browserTest(`Remote Peer ${skin}/${colorScheme}/${width} long content fits the actual Settings pane`, async()=>{
    const f=await setup(skin,width,{long:true,colorScheme});
    try {
      const root=f.page.locator('.remote-peer-settings');
      expect(await root.locator(':scope > .remote-peer-section').count()).toBe(8);
      expect(await root.locator('.remote-peer-identity .remote-peer-actions button').count()).toBe(2);
      const overflow=await root.evaluate((el:HTMLElement)=>{
        const bound=el.getBoundingClientRect();
        return [...el.querySelectorAll<HTMLElement>('section,fieldset,button,input,select,textarea,code,pre')]
          .filter(node=>node.getClientRects().length && (node.getBoundingClientRect().right>bound.right+2||node.getBoundingClientRect().left<bound.left-2))
          .map(node=>({tag:node.tagName,class:node.className}));
      });
      expect(overflow).toEqual([]);
      expect(await root.evaluate((el:HTMLElement)=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
      const sizes=await root.locator('input[type=checkbox]').evaluateAll((nodes:HTMLInputElement[])=>nodes.map(el=>({w:el.getBoundingClientRect().width,h:el.getBoundingClientRect().height,type:el.type})));
      for(const size of sizes){expect(size.type).toBe('checkbox');expect(size.w).toBeLessThan(30);expect(size.h).toBeLessThan(30);}
      const field=await f.page.getByLabel('Peer client ID',{exact:true}).evaluate((el:HTMLElement)=>{
        const box=el.getBoundingClientRect(),parent=el.parentElement!.getBoundingClientRect();
        return {w:box.width,parent:parent.width};
      });
      expect(field.w).toBeGreaterThan(field.parent*0.9);
      const fonts=await root.evaluate((el:HTMLElement)=>({base:getComputedStyle(el).fontSize,heading:getComputedStyle(el.querySelector('h4')!).fontSize}));
      expect(fonts).toEqual({base:'13px',heading:skin === 'visual' ? '13px' : '14px'});
      const evidence=process.env.PICLAW_REMOTE_PEER_SCREENSHOT_DIR;
      if(evidence && [1366,390].includes(width)) {
        if(!isAbsolute(evidence))throw Error('Screenshot directory must be absolute');
        mkdirSync(evidence,{recursive:true});
        await root.screenshot({path:join(evidence,`settings-${skin}-${colorScheme}-${width}.png`)});
      }
      expect(f.writes).toEqual([]);expect(f.failure.remoteCalls).toBe(0);expect(f.errors).toEqual([]);
    }finally{await f.page.close();}
  },20000);
}
