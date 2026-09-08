import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPeerService } from "./runtime-service.js";
const baseDir = dirname(fileURLToPath(import.meta.url));
export async function runAction(
  input: Record<string, any>,
  service = getPeerService(),
) {
  switch (input.action) {
    case "status":
      return service.dashboard();
    case "identity":
      return service.identity();
    case "ticket":
      await service.start();
      return { ticket: service.transport.ticket(), ...service.identity() };
    case "pair":
      return service.pair({
        clientId: String(input.client_id ?? ""),
        alias: input.alias,
        ticket: input.ticket,
      });
    case "accept":
      await service.accept(
        String(input.peer ?? ""),
        String(input.confirmation ?? ""),
      );
      break;
    case "deny":
      service.deny(String(input.peer ?? ""));
      break;
    case "revoke":
      await service.revoke(
        String(input.peer ?? ""),
        String(input.confirmation ?? ""),
      );
      break;
    case "rotate":
      return {
        identity: await service.rotateIdentity(
          String(input.confirmation ?? ""),
        ),
      };
    case "forget":
      service.forget(
        String(input.peer ?? ""),
        String(input.confirmation ?? ""),
      );
      break;
    case "alias":
      service.setAlias(String(input.peer ?? ""), String(input.alias ?? ""));
      break;
    case "policy":
      service.setPolicy(String(input.peer ?? ""), input);
      break;
    case "advertise":
      await service.advertise(
        String(input.local_agent ?? ""),
        String(input.alias ?? ""),
        input.modes ?? ["queue"],
      );
      break;
    case "unadvertise":
      service.unadvertise(String(input.alias ?? ""));
      break;
    case "ping":
      return service.ping(String(input.peer ?? ""));
    case "retry":
      return service.retry(String(input.message_id ?? ""));
    case "work_send":
      return service.workSend(
        String(input.peer ?? ""),
        String(input.prompt ?? ""),
        input.request_type ?? "proposal",
        input.capabilities ?? [],
        String(input.origin_chat ?? ""),
      );
    case "work_review":
      return service.reviewWork(
        String(input.request_id ?? ""),
        String(input.result ?? ""),
        input.capabilities ?? [],
        input.approve === true,
      );
    default:
      throw new Error("Unknown Iroh Remote Peer action.");
  }
  return { ok: true };
}
const register = (globalThis as any).__piclaw_registerAddonConfigApi;
if (register) {
  register(
    "remote-peer",
    "config",
    {
      get: () => ({
        config: getPeerService().state.config(),
        identity: getPeerService().identity(),
      }),
      set: async (input: unknown) => ({
        config: await getPeerService().configure(input as any),
        identity: getPeerService().identity(),
      }),
    },
    baseDir,
  );
  register(
    "remote-peer",
    "dashboard",
    {
      get: () => getPeerService().dashboard(),
      set: async (input: Record<string, any>) => {
        const result = await runAction(input);
        return { ...(await getPeerService().dashboard()), result };
      },
    },
    baseDir,
  );
}
export default function remotePeer(pi: ExtensionAPI) {
  pi.on("resources_discover", () => ({
    skillPaths: [join(baseDir, "skills/remote-peer/SKILL.md")],
  }));
  pi.registerTool({
    name: "remote_peer",
    label: "Remote Peer",
    description:
      "Manage Iroh client-ID pairing, permissions, local discovery status and delivery retries. Use chat for ordinary peer conversations.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "status",
            "identity",
            "ticket",
            "pair",
            "accept",
            "deny",
            "revoke",
            "forget",
            "rotate",
            "alias",
            "policy",
            "advertise",
            "unadvertise",
            "ping",
            "retry",
            "work_send",
            "work_review",
          ],
        },
        client_id: { type: "string" },
        peer: { type: "string" },
        ticket: { type: "string" },
        alias: { type: "string" },
        confirmation: { type: "string" },
        scope: {
          type: "string",
          enum: ["none", "inbox-only", "named-agents", "all-advertised"],
        },
        modes: {
          type: "array",
          items: { type: "string", enum: ["queue", "auto", "steer"] },
        },
        agents: { type: "array", items: { type: "string" } },
        files: { type: "boolean" },
        local_agent: { type: "string" },
        message_id: { type: "string" },
        prompt: { type: "string" },
        request_type: { type: "string", enum: ["proposal", "execute"] },
        capabilities: { type: "array", items: { type: "string" } },
        origin_chat: { type: "string" },
        request_id: { type: "string" },
        result: { type: "string" },
        approve: { type: "boolean" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(_id, params: any) {
      try {
        const details = await runAction(params);
        return {
          content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
          details,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          details: { error: message },
          isError: true,
        };
      }
    },
  });
}
