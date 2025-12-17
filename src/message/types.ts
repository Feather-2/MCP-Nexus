export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: Array<{
    name: string;
    arguments: Record<string, unknown>;
  }>;
}

export interface TokenCounter {
  count(message: Message): number;
}

