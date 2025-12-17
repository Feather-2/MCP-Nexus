import { NaiveCounter } from './naive-counter.js';
import type { Message, TokenCounter } from './types.js';

function cloneMessage(message: Message): Message {
  const cloned: Message = {
    role: message.role,
    content: message.content
  };

  if (message.toolCalls) {
    cloned.toolCalls = message.toolCalls.map((call) => ({
      name: call.name,
      arguments: { ...call.arguments }
    }));
  }

  return cloned;
}

export class MessageTrimmer {
  constructor(
    private maxTokens: number,
    private counter: TokenCounter = new NaiveCounter()
  ) {}

  // 裁剪历史，保留最新的消息直到达到 token 预算
  // 返回新数组，不修改原数组
  trim(history: Message[]): Message[] {
    if (this.maxTokens <= 0) {
      return [];
    }

    let tokens = 0;
    const kept: Message[] = [];

    for (let i = history.length - 1; i >= 0; i--) {
      const candidate = history[i];
      const cost = this.counter.count(candidate);
      if (tokens + cost > this.maxTokens) {
        break;
      }
      kept.push(cloneMessage(candidate));
      tokens += cost;
    }

    kept.reverse();
    return kept;
  }
}
