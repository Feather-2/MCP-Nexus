import type { Message, TokenCounter } from './types.js';

// 朴素 token 计数器，基于字符长度估算
// 故意偏高估算以避免超出上游 context 限制
export class NaiveCounter implements TokenCounter {
  count(msg: Message): number {
    let tokens =
      Math.ceil(msg.content.length / 4) + Math.ceil(msg.role.length / 10);
    for (const call of msg.toolCalls ?? []) {
      tokens += call.name.length;
      for (const [k, v] of Object.entries(call.arguments)) {
        tokens += k.length;
        if (typeof v === 'string') {
          tokens += Math.ceil(v.length / 4);
        } else {
          tokens += 1;
        }
      }
    }
    return Math.max(tokens, 1);
  }
}

