import { AiError, type AiClientConfig, type ChannelConfig, type ChannelLease, type ChannelState } from './types.js';

type ChannelRuntime = {
  config: ChannelConfig;
  keys: string[];
  weight: number;
  state: ChannelState;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseKeysFromSource(config: ChannelConfig): string[] {
  const { keySource } = config;
  const raw = keySource.type === 'env' ? (process.env[keySource.value] ?? '') : keySource.value;

  switch (keySource.format) {
    case 'single': {
      const trimmed = raw.trim();
      return trimmed.length === 0 ? [] : [trimmed];
    }
    case 'newline': {
      return raw
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    }
    case 'json': {
      const trimmed = raw.trim();
      if (trimmed.length === 0) return [];

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed) as unknown;
      } catch {
        return [];
      }

      if (!Array.isArray(parsed)) return [];
      return parsed.map((v) => (typeof v === 'string' ? v.trim() : '')).filter((v) => v.length > 0);
    }
    /* c8 ignore next 4 */
    default: {
      const _exhaustive: never = keySource.format;
      return _exhaustive;
    }
  }
}

function isKeyEnabledNow(key: ChannelState['keys'][number], now: Date): boolean {
  if (key.enabled) return true;
  if (!key.disabledUntil) return false;
  return now.getTime() >= key.disabledUntil.getTime();
}

function refreshKeyIfExpired(key: ChannelState['keys'][number], now: Date): void {
  if (!key.enabled && key.disabledUntil && now.getTime() >= key.disabledUntil.getTime()) {
    key.enabled = true;
    key.disabledAt = undefined;
    key.disabledUntil = undefined;
    key.disabledReason = undefined;
  }
}

function refreshChannelIfExpired(state: ChannelState, now: Date): void {
  if (!state.cooldownUntil) return;
  if (now.getTime() < state.cooldownUntil.getTime()) return;

  const shouldEnable = !state.enabled;
  state.cooldownUntil = undefined;
  if (shouldEnable) {
    state.enabled = true;
    state.consecutiveFailures = 0;
  }
}

function channelMatchesTags(config: ChannelConfig, tags?: string[]): boolean {
  if (!tags || tags.length === 0) return true;
  const channelTags = config.tags ?? [];
  return tags.every((t) => channelTags.includes(t));
}

function hasAnyEnabledKey(state: ChannelState, now: Date): boolean {
  return state.keys.some((k) => isKeyEnabledNow(k, now));
}

function weightedPick<T>(items: readonly { item: T; weight: number }[]): T {
  const total = items.reduce((sum, it) => sum + it.weight, 0);

  const r = Math.random() * total;
  let acc = 0;
  let picked = items[items.length - 1].item;
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    acc += it.weight;
    if (r < acc) {
      picked = it.item;
      break;
    }
  }
  return picked;
}

export class ChannelManager {
  private readonly channels = new Map<string, ChannelRuntime>();

  constructor(private readonly config: AiClientConfig) {
    for (const channel of config.channels) {
      const keys = parseKeysFromSource(channel);
      const weight = Math.max(0, channel.weight ?? 1);

      this.channels.set(channel.id, {
        config: channel,
        keys,
        weight,
        state: {
          channelId: channel.id,
          enabled: channel.enabled ?? true,
          keys: keys.map((_, idx) => ({
            index: idx,
            enabled: true,
            errorCount: 0,
            totalRequests: 0,
            totalTokens: 0
          })),
          pollingIndex: 0,
          consecutiveFailures: 0,
          cooldownUntil: undefined,
          metrics: {
            totalRequests: 0,
            totalErrors: 0,
            avgLatencyMs: 0,
            lastRequestAt: undefined
          }
        }
      });
    }
  }

  acquire(channelId?: string, tags?: string[]): ChannelLease {
    const now = new Date();
    const candidates: ChannelRuntime[] = [];

    if (isNonEmptyString(channelId)) {
      const runtime = this.channels.get(channelId);
      if (!runtime) throw new AiError(`Unknown channel: ${channelId}`, 'invalid_request');
      candidates.push(runtime);
    } else {
      candidates.push(...this.channels.values());
    }

    const eligible = candidates
      .filter((rt) => channelMatchesTags(rt.config, tags))
      .filter((rt) => {
        refreshChannelIfExpired(rt.state, now);
        for (const key of rt.state.keys) refreshKeyIfExpired(key, now);

        if (!rt.state.enabled) return false;
        if (rt.state.cooldownUntil && now.getTime() < rt.state.cooldownUntil.getTime()) return false;
        if (rt.weight <= 0) return false;
        if (!hasAnyEnabledKey(rt.state, now)) return false;
        return true;
      });

    if (eligible.length === 0) {
      if (isNonEmptyString(channelId)) {
        throw new AiError(`Channel not available: ${channelId}`, 'unknown', undefined, true);
      }
      throw new AiError('No available AI channels', 'unknown', undefined, true);
    }

    const pickedChannel =
      eligible.length === 1
        ? eligible[0]
        : weightedPick(eligible.map((rt) => ({ item: rt, weight: rt.weight })));

    const keySelection = this.pickKey(pickedChannel, now);

    return {
      channelId: pickedChannel.config.id,
      keyIndex: keySelection.keyIndex,
      apiKey: keySelection.apiKey,
      provider: pickedChannel.config.provider,
      model: pickedChannel.config.model,
      baseUrl: pickedChannel.config.baseUrl,
      headers: pickedChannel.config.headers,
      attempt: 1,
      acquiredAt: now
    };
  }

  report(
    lease: ChannelLease,
    outcome: {
      success: boolean;
      latencyMs: number;
      tokens?: number;
      error?: AiError;
    }
  ): void {
    const runtime = this.channels.get(lease.channelId);
    if (!runtime) throw new AiError(`Unknown channel: ${lease.channelId}`, 'invalid_request');

    const now = new Date();
    refreshChannelIfExpired(runtime.state, now);

    const key = runtime.state.keys[lease.keyIndex];
    if (!key) throw new AiError(`Unknown key index: ${lease.keyIndex}`, 'invalid_request');
    refreshKeyIfExpired(key, now);

    key.totalRequests += 1;
    key.totalTokens += outcome.tokens ?? 0;
    key.lastUsedAt = now;

    runtime.state.metrics.totalRequests += 1;
    runtime.state.metrics.lastRequestAt = now;
    if (runtime.state.metrics.totalRequests === 1) {
      runtime.state.metrics.avgLatencyMs = outcome.latencyMs;
    } else {
      const n = runtime.state.metrics.totalRequests;
      const prev = runtime.state.metrics.avgLatencyMs;
      runtime.state.metrics.avgLatencyMs = (prev * (n - 1) + outcome.latencyMs) / n;
    }

    if (outcome.success) {
      runtime.state.consecutiveFailures = 0;
      return;
    }

    key.errorCount += 1;
    runtime.state.metrics.totalErrors += 1;
    runtime.state.consecutiveFailures += 1;

    if (outcome.error?.retryAfterMs !== undefined && outcome.error.retryAfterMs > 0) {
      const until = new Date(now.getTime() + outcome.error.retryAfterMs);
      const current = runtime.state.cooldownUntil;
      if (!current || until.getTime() > current.getTime()) {
        runtime.state.cooldownUntil = until;
      }
    }
  }

  getState(channelId: string): ChannelState | undefined {
    const runtime = this.channels.get(channelId);
    if (!runtime) return undefined;

    const now = new Date();
    refreshChannelIfExpired(runtime.state, now);
    for (const key of runtime.state.keys) refreshKeyIfExpired(key, now);

    return ChannelManager.cloneState(runtime.state);
  }

  getAllStates(): ChannelState[] {
    const now = new Date();
    const states: ChannelState[] = [];
    for (const runtime of this.channels.values()) {
      refreshChannelIfExpired(runtime.state, now);
      for (const key of runtime.state.keys) refreshKeyIfExpired(key, now);
      states.push(ChannelManager.cloneState(runtime.state));
    }
    states.sort((a, b) => a.channelId.localeCompare(b.channelId));
    return states;
  }

  disableKey(channelId: string, keyIndex: number, reason: string, durationMs?: number): void {
    const runtime = this.channels.get(channelId);
    if (!runtime) throw new AiError(`Unknown channel: ${channelId}`, 'invalid_request');
    const key = runtime.state.keys[keyIndex];
    if (!key) throw new AiError(`Unknown key index: ${keyIndex}`, 'invalid_request');

    const now = new Date();
    key.enabled = false;
    key.disabledAt = now;
    key.disabledReason = reason;
    key.disabledUntil = durationMs === undefined ? undefined : new Date(now.getTime() + durationMs);
  }

  enableKey(channelId: string, keyIndex: number): void {
    const runtime = this.channels.get(channelId);
    if (!runtime) throw new AiError(`Unknown channel: ${channelId}`, 'invalid_request');
    const key = runtime.state.keys[keyIndex];
    if (!key) throw new AiError(`Unknown key index: ${keyIndex}`, 'invalid_request');

    key.enabled = true;
    key.disabledAt = undefined;
    key.disabledUntil = undefined;
    key.disabledReason = undefined;
  }

  disableChannel(channelId: string, reason: string, durationMs?: number): void {
    const runtime = this.channels.get(channelId);
    if (!runtime) throw new AiError(`Unknown channel: ${channelId}`, 'invalid_request');

    const now = new Date();
    runtime.state.enabled = false;
    runtime.state.cooldownUntil = durationMs === undefined ? undefined : new Date(now.getTime() + durationMs);
    runtime.state.consecutiveFailures = 0;
    void reason;
  }

  enableChannel(channelId: string): void {
    const runtime = this.channels.get(channelId);
    if (!runtime) throw new AiError(`Unknown channel: ${channelId}`, 'invalid_request');

    runtime.state.enabled = true;
    runtime.state.cooldownUntil = undefined;
    runtime.state.consecutiveFailures = 0;
  }

  private pickKey(
    runtime: ChannelRuntime,
    now: Date
  ): { keyIndex: number; apiKey: string } {
    const mode = runtime.config.keyRotation ?? 'polling';
    const keys = runtime.state.keys;

    for (const key of keys) refreshKeyIfExpired(key, now);

    if (mode === 'random') {
      const enabledIndices = keys.filter((k) => k.enabled).map((k) => k.index);
      const idx = enabledIndices[Math.floor(Math.random() * enabledIndices.length)];
      return { keyIndex: idx, apiKey: runtime.keys[idx] };
    }

    // polling
    const start = runtime.state.pollingIndex % keys.length;
    let selected = start;
    for (let offset = 0; offset < keys.length; offset += 1) {
      const idx = (start + offset) % keys.length;
      const state = keys[idx];
      if (!state.enabled) continue;

      selected = idx;
      break;
    }
    runtime.state.pollingIndex = (selected + 1) % keys.length;
    return { keyIndex: selected, apiKey: runtime.keys[selected] };
  }

  private static cloneState(state: ChannelState): ChannelState {
    return {
      channelId: state.channelId,
      enabled: state.enabled,
      keys: state.keys.map((k) => ({
        index: k.index,
        enabled: k.enabled,
        disabledAt: k.disabledAt ? new Date(k.disabledAt.getTime()) : undefined,
        disabledUntil: k.disabledUntil ? new Date(k.disabledUntil.getTime()) : undefined,
        disabledReason: k.disabledReason,
        errorCount: k.errorCount,
        lastUsedAt: k.lastUsedAt ? new Date(k.lastUsedAt.getTime()) : undefined,
        totalRequests: k.totalRequests,
        totalTokens: k.totalTokens
      })),
      pollingIndex: state.pollingIndex,
      consecutiveFailures: state.consecutiveFailures,
      cooldownUntil: state.cooldownUntil ? new Date(state.cooldownUntil.getTime()) : undefined,
      metrics: {
        totalRequests: state.metrics.totalRequests,
        totalErrors: state.metrics.totalErrors,
        avgLatencyMs: state.metrics.avgLatencyMs,
        lastRequestAt: state.metrics.lastRequestAt
          ? new Date(state.metrics.lastRequestAt.getTime())
          : undefined
      }
    };
  }
}
