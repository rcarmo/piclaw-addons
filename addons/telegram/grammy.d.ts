declare module "grammy" {
  export class Api {
    constructor(token: string);
    getMe(): Promise<{ id: number; username?: string }>;
    getUpdates(params: {
      offset?: number;
      timeout?: number;
      allowed_updates?: string[];
    }): Promise<Array<Record<string, unknown>>>;
    sendMessage(
      chatId: string | number,
      text: string,
      params?: { message_thread_id?: number },
    ): Promise<unknown>;
    sendChatAction(
      chatId: string | number,
      action: "typing",
      params?: { message_thread_id?: number },
    ): Promise<unknown>;
  }
}
