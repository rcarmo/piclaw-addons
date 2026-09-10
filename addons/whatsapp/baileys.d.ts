declare module "@whiskeysockets/baileys" {
  export interface WASocket {
    ev: { on(event: string, listener: (payload: any) => void): void };
    sendMessage(jid: string, content: { text: string }): Promise<unknown>;
    sendPresenceUpdate(state: "available" | "composing" | "paused", jid?: string): Promise<unknown>;
    requestPairingCode(phoneNumber: string): Promise<string | undefined>;
    end(error?: Error): void;
  }

  const makeWASocket: (options: Record<string, unknown>) => WASocket;
  export default makeWASocket;
  export const Browsers: { macOS(name: string): [string, string, string] };
  export const DisconnectReason: { loggedOut: number };
  export function makeCacheableSignalKeyStore(keys: unknown, logger: unknown): unknown;
  export function useMultiFileAuthState(path: string): Promise<{
    state: { creds: { registered?: boolean }; keys: unknown };
    saveCreds: () => Promise<void>;
  }>;
}
