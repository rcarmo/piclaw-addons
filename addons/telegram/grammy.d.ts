declare module "grammy" {
  export class Api {
    constructor(token: string);
    getMe(signal?: AbortSignal): Promise<{ id: number; username?: string }>;
    getUpdates(
      other?: { offset?: number; timeout?: number; allowed_updates?: string[] },
      signal?: AbortSignal,
    ): Promise<Array<Record<string, unknown>>>;
    sendMessage(
      chatId: string | number,
      text: string,
      other?: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<unknown>;
    sendChatAction(
      chatId: string | number,
      action: "typing",
      other?: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<unknown>;
  }
}
