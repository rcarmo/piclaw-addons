/** Deterministic loopback provider for opt-in tests. Starts only when explicitly called. */
export function startReviewProvider(options: { busyPrelude?: boolean } = {}) {
  const requests: any[] = [];
  let busyStarted = false, busyFinished = false, busyAborted = false;
  let releaseBusy!: () => void;
  const busyGate = new Promise<void>((resolve) => { releaseBusy = resolve; });
  let step = -1,
    dispatchId = "",
    thread: any = null,
    offered = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/v1/chat/completions")
        return new Response("Not found", { status: 404 });
      const body = await req.json();
      if (options.busyPrelude && !busyStarted && JSON.stringify(body.messages).includes("CODE_REVIEW_BUSY_FIXTURE")) {
        busyStarted = true;
        req.signal.addEventListener("abort", () => { busyAborted = true; }, { once: true });
        await busyGate;
        busyFinished = true;
        const base = { id: "review-busy-fixture", object: "chat.completion.chunk", created: 1, model: "review-fixture" };
        return new Response(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Prior fixture work finished." }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`, {
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        });
      }
      requests.push(body);
      offered ||=
        Array.isArray(body.tools) &&
        body.tools.some((t: any) => t.function?.name === "code_review");
      const text = JSON.stringify(body.messages);
      dispatchId ||= text.match(/dispatch_[a-f0-9-]+/)?.[0] || "";
      const toolMessages = (body.messages || []).filter(
        (m: any) => m.role === "tool",
      );
      const parse = (value: any) => {
        if (Array.isArray(value))
          value = value
            .filter((v: any) => v.type === "text")
            .map((v: any) => v.text)
            .join("");
        try {
          return JSON.parse(value);
        } catch {
          return null;
        }
      };
      const previous = toolMessages.length
        ? parse(toolMessages.at(-1).content)
        : null;
      let args: any = null;
      if (!dispatchId || step > 5)
        return new Response("Unexpected provider turn", { status: 400 });
      if (step === -1) args = { names: ["code_review"], mode: "append" };
      else if (step === 0) args = { action: "dispatch", dispatchId };
      else if (step === 1) {
        const id = previous?.items?.[0]?.thread_id;
        if (!id)
          return new Response(
            "Dispatch read failed: " + JSON.stringify(previous),
            { status: 400 },
          );
        args = { action: "thread", threadId: id };
      } else if (step === 2) {
        thread = previous;
        if (!thread?.id)
          return new Response("Thread read failed", { status: 400 });
        if (thread.currentSource?.status !== "unchanged" || thread.currentSource?.savedHash !== undefined)
          return new Response("Current source status missing or leaking a hash", { status: 400 });
        args = {
          action: "reply",
          threadId: thread.id,
          body: "Verified the saved source in the disposable fixture.",
          expectedVersion: thread.version,
          assignmentEpoch: thread.assignment_epoch,
          requestId: "fixture-reply",
        };
      } else if (step === 3) {
        if (!previous?.version)
          return new Response("Reply failed", { status: 400 });
        args = {
          action: "resolve",
          threadId: thread.id,
          fileId: thread.source.fileId,
          explanation: "Fixture verification: no code edit needed.",
          evidence: ["review-fixture.ts#L2"],
          expectedVersion: previous.version,
          assignmentEpoch: thread.assignment_epoch,
          requestId: "fixture-resolve",
        };
      } else if (step === 4) {
        if (!previous?.version)
          return new Response("Resolution failed", { status: 400 });
        args = {
          action: "work",
          dispatchId,
          threadId: thread.id,
          state: "completed",
          itemVersion: 1,
          threadVersion: previous.version,
          assignmentEpoch: thread.assignment_epoch,
          requestId: "fixture-work",
        };
      }
      const index = step++;
      const base = {
        id: "review-fixture-" + index,
        object: "chat.completion.chunk",
        created: 1,
        model: "review-fixture",
      };
      const delta = args
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "fixture-call-" + index,
                type: "function",
                function: {
                  name: index === -1 ? "activate_tools" : "code_review",
                  arguments: JSON.stringify(args),
                },
              },
            ],
          }
        : { role: "assistant", content: "Fixture review completed." };
      const data = `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: args ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`;
      return new Response(data, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
      });
    },
  });
  return {
    server,
    requests,
    get busyStarted() { return busyStarted; },
    get busyFinished() { return busyFinished; },
    get busyAborted() { return busyAborted; },
    releaseBusy,
    get offered() {
      return offered;
    },
    get completed() {
      return step >= 6;
    },
    baseUrl: server.url.href + "v1",
    stop() {
      releaseBusy();
      server.stop(true);
    },
  };
}
