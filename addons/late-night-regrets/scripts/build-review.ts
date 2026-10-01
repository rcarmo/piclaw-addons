#!/usr/bin/env bun
/** Read-only input builder and offline cutoff comparison. No model calls or note writes. */
import { parseArgs } from "node:util";
import { join } from "node:path";
import { readExchanges, selectReview, compactPacket } from "../review.js";
import { loadRanker, rankExchange } from "../ranker.js";
if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      db: { type: "string" },
      chat: { type: "string", default: "*" },
      end: { type: "string" },
      hours: { type: "string", default: "24" },
      budget: { type: "string", default: "24000" },
      weights: { type: "string" },
      compare: { type: "boolean" },
      help: { type: "boolean" },
    },
    strict: true,
  });
  if (values.help) {
    console.log(
      "build-review.ts --db PATH [--chat JID --end ISO --hours 24 --budget 24000 --weights PATH --compare]\nWrites JSON to stdout. --compare emits counts/IDs only for several cutoffs; no inference.",
    );
    process.exit(0);
  }
  const hours = Number(values.hours),
    end = new Date(values.end || Date.now());
  if (
    !Number.isFinite(hours) ||
    hours <= 0 ||
    hours > 168 ||
    !Number.isFinite(end.getTime())
  )
    throw new Error("Invalid window");
  const window = {
    start: new Date(end.getTime() - hours * 3600000).toISOString(),
    end: end.toISOString(),
    chat_jid: values.chat!,
  };
  const workspace = process.env.PICLAW_WORKSPACE || process.cwd();
  const path =
    values.db ||
    join(
      process.env.PICLAW_STORE || join(workspace, ".piclaw", "store"),
      "messages.db",
    );
  const { exchanges, excluded } = readExchanges(path, window);
  const model = values.weights ? loadRanker(values.weights) : undefined;
  if (values.weights && !model) throw new Error("Invalid ranker file");
  const rank = model
    ? (e: (typeof exchanges)[number]) => rankExchange(e, model)
    : undefined;
  if (values.compare) {
    const summaries = [4000, 8000, 16000, 100000].map((budget) => {
      const started = performance.now(),
        p = selectReview(exchanges, window, budget, excluded, rank);
      return {
        ...p.coverage,
        rowids: p.exchanges.map((e) => e.rowid),
        elapsed_ms: Math.round(performance.now() - started),
      };
    });
    console.log(
      JSON.stringify(
        { window, comparisons: summaries, model_calls: 0 },
        null,
        2,
      ),
    );
  } else
    console.log(
      JSON.stringify(
        compactPacket(
          selectReview(
            exchanges,
            window,
            Number(values.budget),
            excluded,
            rank,
          ),
        ),
      ),
    );
}
