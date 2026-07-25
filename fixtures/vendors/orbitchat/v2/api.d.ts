export interface CreateMessageInput {
  readonly channelId: string;
  readonly content: string;
  readonly notification?: {
    readonly enabled: boolean;
  };
}

export interface CreateMessageResult {
  readonly id: string;
  readonly createdAt: string;
}

export interface OrbitChatClient {
  readonly messages: {
    create(input: CreateMessageInput): Promise<CreateMessageResult>;
  };
}

export declare const version: "2.0.0";
