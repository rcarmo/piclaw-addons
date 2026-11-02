import { describe, expect, test } from "bun:test";
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildExchange,
  boundedText,
  compactPacket,
  exclusion,
  readExchanges,
  selectReview,
  type Exchange,
  type MessageRow,
} from "./review.js";
import { rankExchange } from "./ranker.js";
import { DEFAULT_CONFIG, normaliseConfig } from "./config.js";
import {
  decideReview,
  parseDecisions,
  type DecisionRuntime,
} from "./decision.js";
import { reflectionPrompt } from "./reflection-prompt.js";
import { createLateNightRegrets } from "./native.js";
import { loadRanker } from "./ranker.js";

const window = {
  start: "2026-01-02T00:00:00Z",
  end: "2026-01-03T00:00:00Z",
  chat_jid: "web:test",
};
const row = (
  rowid: number,
  content = "plain English",
  extra: Partial<MessageRow> = {},
): MessageRow => ({
  rowid,
  content,
  chat_jid: window.chat_jid,
  timestamp: "2026-01-02T12:00:00Z",
  sender: "web-user",
  sender_name: "Human",
  ...extra,
});
const exchange = (id: number): Exchange => buildExchange(row(id), []);

describe("budgeted daily input", () => {
  test("host access denial stops native history/model reads without an ambient config parser", async () => {
    let reads = 0;
    const native = createLateNightRegrets({ chat: window.chat_jid, cwd: '/fixture', assertCurrent() {},
      assertSingleUser() { throw Error('single-user required by host'); }, config: { get: () => DEFAULT_CONFIG, set() {} },
      async history() { reads++; throw Error('History forbidden'); }, async readFile() { reads++; throw Error('Files forbidden'); },
      accountedDecision: { getAvailable() { reads++; return []; }, async complete() { reads++; throw Error('Model forbidden'); } },
      async admitConversationInput() { throw Error('No input'); },
    });
    await expect(native.tool.execute('denied', {})).rejects.toThrow('single-user');
    expect(reads).toBe(0);
    expect(loadRanker('/fixture/missing.json')).toBeUndefined();
  });
  test("one short message is reviewed, ranker is never invoked below cutoff", () => {
    const packet = selectReview([exchange(1)], window, 16000, {}, () => {
      throw Error("must not rank");
    });
    expect(packet.coverage.mode).toBe("all");
    expect(packet.exchanges[0].target.content).toBe("plain English");
    expect(packet.coverage.omitted).toBe(0);
  });
  test("keep short continuations; structured and legacy peer provenance excluded", () => {
    expect(exclusion(row(1, "continue"))).toBeNull();
    expect(exclusion(row(1, "From: my report"))).toBeNull();
    expect(
      exclusion(
        row(1, "x", {
          content_blocks: JSON.stringify([
            { type: "restart_handoff", source: "exit_process" },
          ]),
        }),
      ),
    ).toBe("structured_automation");
    expect(exclusion(row(1, "From: Smith\nReply-To: @x\nTo: @y\nhello"))).toBe(
      "legacy_peer_envelope",
    );
    expect(
      exclusion(
        row(1, "Recovery resumed", {
          content_blocks: JSON.stringify([
            {
              type: "control_intent",
              intent: "protected_recovery_continuation",
            },
          ]),
        }),
      ),
    ).toBe("structured_automation");
    expect(
      exclusion(row(1, "feedback", { content_blocks: "broken" })),
    ).toBeNull();
    expect(
      exclusion(row(1, "human called Smith", { sender_name: "Smith" })),
    ).toBeNull();
  });
  test("same-chat bounded context, explicit prior reference, no cross-chat reference", () => {
    const target = row(100);
    const context = Array.from({ length: 12 }, (_, i) => row(90 + i));
    const built = buildExchange(target, context, [
      row(1, "We ran Node tests", { sender: "agent" }),
      row(2, "other", { chat_jid: "web:other" }),
      row(200),
    ]);
    expect(built.context.map((r) => r.rowid)).toEqual([
      1, 94, 95, 96, 97, 98, 99, 101,
    ]);
  });
  test("repeated context is sent once with resolvable per-exchange references", () => {
    const shared = row(1, "earlier response", { sender: "agent" });
    const packet = selectReview(
      [buildExchange(row(2), [shared]), buildExchange(row(3), [shared])],
      window,
    );
    const compact = compactPacket(packet);
    expect(compact.context_messages).toHaveLength(1);
    expect(compact.exchanges.map((e) => e.context_ids)).toEqual([[1], [1]]);
    expect(compact.context_messages[0].chat_jid).toBe(window.chat_jid);
  });
  test("overflow includes reproducible sample and fits the SDK estimated-token budget", () => {
    const rows = Array.from({ length: 80 }, (_, i) =>
      buildExchange(row(i, "x ".repeat(120)), []),
    );
    const a = selectReview(rows, window, 2000, {}, (e) => -e.rowid);
    const b = selectReview(rows, window, 2000, {}, (e) => -e.rowid);
    expect(a).toEqual(b);
    expect(a.coverage.mode).toBe("ranked_sample");
    expect(a.coverage.sampled).toBeGreaterThan(0);
    expect(a.exchanges.some((e) => e.rowid === 0)).toBe(true);
    expect(a.coverage.omitted).toBeGreaterThan(0);
    expect(a.coverage.estimated_tokens).toBe(estimateTextTokens(JSON.stringify(compactPacket(a))));
    expect(a.coverage.estimated_tokens).toBeLessThanOrEqual(2000);
    expect(a.exchanges).toEqual(rows.filter(row => a.exchanges.some(selected => selected.rowid === row.rowid)));
  });
  test("no fabricated clean day when all individual contexts exceed the cap", () => {
    const big = buildExchange(
      row(20, "user\n".repeat(400)),
      Array.from({ length: 8 }, (_, i) => row(i, "context\n".repeat(150))),
    );
    const result = selectReview([big], window, 512);
    expect(result.coverage.omitted).toBe(1);
    expect(result.exchanges).toHaveLength(0);
    expect(result.coverage.mode).toBe("sample_only");
  });
  test("code, keys and credential-bearing lines are removed before any model call", () => {
    const result = boundedText(
      "plain English\n```\nsecret stuff\n```\npassword: do-not-send\n-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\nnormal",
    );
    expect(result.content).not.toContain("do-not-send");
    expect(result.content).not.toContain("secret stuff");
    expect(result.content).not.toContain("BEGIN PRIVATE KEY");
    expect(result.content).toContain("plain English");
    expect(result.truncated).toBe(true);
  });
  test("frozen ranker is finite and does not use future assistant context", () => {
    const model = {
      bias: 1,
      weights: { "ctx:claimed_success": 2 },
      options: { context: true },
    };
    const e = exchange(5),
      score = rankExchange(e, model);
    e.context.push({
      rowid: 6,
      speaker: "assistant",
      content: "done fixed failed",
      truncated: false,
    });
    expect(Number.isFinite(score)).toBe(true);
    expect(rankExchange(e, model)).toBe(score);
  });
  test("SQLite reader is read-only, scoped, excludes erased/future data and loads earlier context", () => {
    const dir = mkdtempSync(join(tmpdir(), "regrets-review-"));
    const path = join(dir, "fixture.db");
    try {
      const db = new Database(path);
      db.run(
        "CREATE TABLE messages(chat_jid TEXT,sender TEXT,sender_name TEXT,content TEXT,timestamp TEXT,is_bot_message INTEGER,content_blocks TEXT,thread_id INTEGER,content_erased INTEGER DEFAULT 0)",
      );
      const put = db.query(
        "INSERT INTO messages(rowid,chat_jid,sender,sender_name,content,timestamp,is_bot_message,content_blocks,thread_id,content_erased) VALUES(?,?,?,?,?,?,?,?,?,?)",
      );
      for (const r of [
        row(1, "We ran Node tests", {
          sender: "agent",
          timestamp: "2026-01-01T23:59:00Z",
        }),
        row(2, "Why Node?"),
        row(3, "We only run on Bun"),
        row(4, "private other chat", { chat_jid: "web:other" }),
        row(5, "future", { timestamp: "2026-01-04T00:00:00Z" }),
      ])
        put.run(
          r.rowid,
          r.chat_jid,
          r.sender,
          r.sender_name,
          r.content,
          r.timestamp,
          r.sender === "agent" ? 1 : 0,
          null,
          null,
          0,
        );
      put.run(
        6,
        window.chat_jid,
        "web-user",
        "Human",
        "erased",
        row(1).timestamp,
        0,
        null,
        null,
        1,
      );
      db.close();
      const read = readExchanges(path, window);
      expect(read.exchanges.map((e) => e.rowid)).toEqual([2, 3]);
      expect(read.exchanges[1].context[0].content).toBe("We ran Node tests");
      expect(JSON.stringify(read)).not.toContain("private other");
      expect(JSON.stringify(read)).not.toContain("future");
      expect(JSON.stringify(read)).not.toContain("erased");
      const all = readExchanges(path, { ...window, chat_jid: "*" });
      expect(all.exchanges.map((e) => e.rowid)).toEqual([2, 3, 4]);
      expect(
        all.exchanges
          .find((e) => e.rowid === 3)!
          .context.every((c) => c.rowid !== 4),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const model = {
  provider: "fixture",
  id: "model",
  name: "Fixture",
  maxTokens: 4096,
  contextWindow: 32000,
} as any;
const usage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const runtime = (fn: DecisionRuntime["complete"]): DecisionRuntime => ({
  getAvailable: () => [model],
  complete: fn,
});
const packet = () => selectReview([exchange(1)], window);

describe("optional decision model", () => {
  test("strict exact-once decisions", () => {
    expect(
      parseDecisions('{"decisions":[{"rowid":1,"choice":"uncertain"}]}', [1])[0]
        .choice,
    ).toBe("uncertain");
    for (const value of [
      '{"decisions":[]}',
      '{"decisions":[{"rowid":2,"choice":"routine"}]}',
      '{"decisions":[{"rowid":1,"choice":"bogus"}]}',
      '{"decisions":[{"rowid":1,"choice":"routine","reason":"injected"}]}',
    ])
      expect(() => parseDecisions(value, [1])).toThrow();
  });
  test("off and unavailable selection never call a provider", async () => {
    const r = runtime(async () => {
      throw Error("must not execute");
    });
    expect((await decideReview(packet(), "", r)).status).toBe("disabled");
    expect((await decideReview(packet(), "fixture/missing", r)).status).toBe(
      "unavailable",
    );
  });
  test("one exact model call, untrusted state, no Bayes scores, usage reported", async () => {
    let calls = 0;
    const p = packet(),
      before = JSON.stringify(p);
    const result = await decideReview(
      p,
      "fixture/model",
      runtime(async (m, c, o) => {
        calls++;
        expect(m).toBe(model);
        expect(c.tools).toBeUndefined();
        expect(c.systemPrompt).toContain("untrusted");
        expect(JSON.stringify(c.messages)).not.toContain("ranking");
        expect(o.maxRetries).toBe(0);
        return {
          stopReason: "stop",
          content: [
            {
              type: "text",
              text: '{"decisions":[{"rowid":1,"choice":"routine"}]}',
            },
          ],
          usage,
        } as any;
      }),
    );
    expect(calls).toBe(1);
    expect(result.status).toBe("complete");
    expect(result.usage).toEqual(usage);
    expect(JSON.stringify(p)).toBe(before); // routine must not remove exchanges
  });
  test("invalid outputs fail open without retries and preserve usage", async () => {
    let calls = 0;
    const result = await decideReview(
      packet(),
      "fixture/model",
      runtime(async () => {
        calls++;
        return {
          stopReason: "stop",
          content: [{ type: "text", text: "bad json" }],
          usage,
        } as any;
      }),
    );
    expect(calls).toBe(1);
    expect(result.status).toBe("unavailable");
    expect(result.decisions).toEqual([]);
    expect(result.usage).toEqual(usage);
  });
  test("caller cancellation returns even if provider ignores signal", async () => {
    const controller = new AbortController();
    const promise = decideReview(
      packet(),
      "fixture/model",
      runtime(async () => new Promise(() => {})),
      controller.signal,
    );
    controller.abort();
    expect((await promise).status).toBe("unavailable");
  });
  test("reject malformed bounds, migrate config and replace three-flag gate", () => {
    expect(normaliseConfig({ review_budget_tokens: NaN })).toEqual(
      DEFAULT_CONFIG,
    );
    expect(
      normaliseConfig({ review_budget_tokens: 2 }).review_budget_tokens,
    ).toBe(512);
    expect(normaliseConfig({ decision_model: " " }).decision_model).toBe("");
    expect(() => selectReview([], window, NaN)).toThrow();
    expect(reflectionPrompt()).toContain("one important correction");
    expect(reflectionPrompt()).not.toContain("fewer than 3");
    expect(reflectionPrompt()).toContain("sample");
  });
});

// #1872: producer admission must not bypass malformed metadata or cancellation.
test("decision refuses invalid nominal model limits before its capped output hint", async () => {
  let calls = 0;
  for (const maxTokens of [Infinity, NaN, -1, 4096.5]) {
    const result = await decideReview(packet(), "fixture/model", {
      getAvailable: () => [{ ...model, maxTokens }],
      async complete() { calls++; throw Error("Invalid model must not execute"); },
    });
    expect(result.status).toBe("unavailable");
  }
  expect(calls).toBe(0);
});

test("cancellation wins an already-fulfilled decision while preserving returned usage", async () => {
  const controller = new AbortController();
  const pending = decideReview(packet(), "fixture/model", runtime(() => Promise.resolve({
    role: "assistant", api: "openai-completions", provider: "fixture", model: "model", timestamp: 0,
    stopReason: "stop", content: [{ type: "text", text: '{"decisions":[{"rowid":1,"choice":"routine"}]}' }], usage,
  })), controller.signal);
  controller.abort();
  const result = await pending;
  expect(result.status).toBe("unavailable");
  expect(result.decisions).toEqual([]);
  expect(result.usage).toEqual(usage);
});

test("irreducible packet metadata cannot silently exceed its token budget", () => {
  expect(() => selectReview([], { ...window, chat_jid: "x".repeat(2000) }, 512)).toThrow("metadata");
});

test("genuine input overflow and the 200-exchange ceiling refuse before execution", async () => {
  let calls = 0;
  for (const [input, selected] of [
    [packet(), { ...model, contextWindow: 100 }],
    [selectReview(Array.from({ length: 201 }, (_, id) => exchange(id + 1)), window, 100000), model],
  ] as const) {
    const result = await decideReview(input, "fixture/model", {
      getAvailable: () => [selected],
      async complete() { calls++; throw Error("Oversized request must not execute"); },
    });
    expect(result.status).toBe("unavailable");
    expect(result.decisions).toEqual([]);
  }
  expect(calls).toBe(0);
});
