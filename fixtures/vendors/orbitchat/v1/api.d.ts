export interface SendMessageInput {
  readonly room: string;
  readonly text: string;
  readonly notify?: boolean;
}

export interface SendMessageResult {
  readonly message_id: string;
  readonly created_at: string;
}

export interface OrbitChatClient {
  readonly messages: {
    send(input: SendMessageInput): Promise<SendMessageResult>;
  };
}

export declare const version: "1.0.0";
