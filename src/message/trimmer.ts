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

    // Always preserve system messages first
    let tokens = 0;
    const systemIndices: number[] = [];
    for (let i = 0; i < history.length; i++) {
      if (history[i].role === 'system') {
        tokens += this.counter.count(history[i]);
        systemIndices.push(i);
      }
    }

    // Fill remaining budget from newest non-system messages
    const keptIndices = new Set<number>(systemIndices);
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'system') continue;
      const cost = this.counter.count(history[i]);
      if (tokens + cost > this.maxTokens) break;
      keptIndices.add(i);
      tokens += cost;
    }

    // Reconstruct in original order
    const result: Message[] = [];
    for (let i = 0; i < history.length; i++) {
      if (keptIndices.has(i)) result.push(cloneMessage(history[i]));
    }
    return result;
  }
}
