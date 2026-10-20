import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPeerService } from "./runtime-service.js";
import { getPiclawRuntimeApi, type AddonLocalContext } from "./compat/runtime.js";
const baseDir = dirname(fileURLToPath(import.meta.url));
export { runAction } from "./actions.js";
import { runAction, remotePeerParameters } from "./actions.js";
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
      get: (_input: unknown, req: Request, context?: AddonLocalContext | null) => getPeerService().dashboard(context ?? (req ? getPiclawRuntimeApi()?.localContext?.getRequestContext(req) : null)),
      set: async (input: Record<string, any>, req: Request, context?: AddonLocalContext | null) => {
        const local = context ?? (req ? getPiclawRuntimeApi()?.localContext?.getRequestContext(req) : null);
        const result = await runAction(input, getPeerService(), local);
        return { ...(await getPeerService().dashboard(local)), result };
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
    parameters: remotePeerParameters,
    async execute(_id, params: any) {
      try {
        const details = await runAction(params, getPeerService(), getPiclawRuntimeApi()?.localContext?.getToolContext());
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

export { createRemotePeerTool, createRemotePeerNativeHostPorts, createRemotePeerNativeRoutes, remotePeerResources } from "./native.js";
export type { RemotePeerInvocationOptions, RemotePeerNativeHostPorts, RemotePeerApplicationPorts, RemotePeerAcceptedOperation } from "./native.js";
