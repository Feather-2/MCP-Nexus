import type { EventLogger, LoggedEvent } from '../events/EventLogger.js';
import type { ErrorEnvelope } from '../types/errors.js';

export interface ErrorTrace {
  runId?: string;
  fingerprint: string;
  occurrences: number;
  firstSeen: Date;
  lastSeen: Date;
  events: LoggedEvent[];
  causeChain: ErrorEnvelope[];
}

export class ErrorTracker {
  constructor(private readonly logger: EventLogger) {}

  traceByRunId(runId: string): ErrorTrace[] {
    if (!this.logger.isEnabled()) return [];

    const events = this.logger.query({ limit: 1000 });
    const errorEvents = events.filter((e) => {
      const payload = e.payload as Record<string, unknown> | undefined;
      return payload?.error || payload?.errorEnvelope;
    });

    const filtered = errorEvents.filter((e) => {
      const payload = e.payload as Record<string, unknown> | undefined;
      return payload?.runId === runId;
    });
    return this.groupByFingerprint(filtered);
  }

  traceByFingerprint(fingerprint: string): ErrorTrace {
    if (!this.logger.isEnabled()) {
      return {
        fingerprint,
        occurrences: 0,
        firstSeen: new Date(),
        lastSeen: new Date(),
        events: [],
        causeChain: []
      };
    }

    const events = this.logger.query({ limit: 1000 });
    const errorEvents = events.filter((e) => {
      const payload = e.payload as Record<string, unknown> | undefined;
      const envelope = payload?.errorEnvelope as ErrorEnvelope | undefined;
      return envelope?.fingerprint === fingerprint;
    });

    return this.buildTrace(fingerprint, errorEvents);
  }

  private groupByFingerprint(events: LoggedEvent[]): ErrorTrace[] {
    const groups = new Map<string, LoggedEvent[]>();

    for (const event of events) {
      const payload = event.payload as Record<string, unknown> | undefined;
      const envelope = payload?.errorEnvelope as ErrorEnvelope | undefined;
      const fingerprint = envelope?.fingerprint || 'unknown';

      if (!groups.has(fingerprint)) {
        groups.set(fingerprint, []);
      }
      groups.get(fingerprint)!.push(event);
    }

    return Array.from(groups.entries()).map(([fingerprint, evts]) =>
      this.buildTrace(fingerprint, evts)
    );
  }

  private buildTrace(fingerprint: string, events: LoggedEvent[]): ErrorTrace {
    const sorted = events.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    const first = sorted[0];
    const last = sorted[sorted.length - 1];

    const causeChain: ErrorEnvelope[] = [];
    if (first) {
      const payload = first.payload as Record<string, unknown> | undefined;
      const envelope = payload?.errorEnvelope as ErrorEnvelope | undefined;
      if (envelope) {
        this.extractCauseChain(envelope, causeChain);
      }
    }

    return {
      runId: first ? ((first.payload as Record<string, unknown> | undefined)?.runId as string | undefined) : undefined,
      fingerprint,
      occurrences: events.length,
      firstSeen: first?.timestamp || new Date(),
      lastSeen: last?.timestamp || new Date(),
      events: sorted,
      causeChain
    };
  }

  private extractCauseChain(envelope: ErrorEnvelope, chain: ErrorEnvelope[], maxDepth = 20): void {
    chain.push(envelope);
    if (envelope.cause && maxDepth > 0) {
      this.extractCauseChain(envelope.cause, chain, maxDepth - 1);
    }
  }
}
