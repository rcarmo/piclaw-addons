export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  content_blocks?: unknown[];
  link_previews?: unknown[];
}

export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;
export type OnChatMetadata = (chatJid: string, timestamp: string, name?: string) => void;
