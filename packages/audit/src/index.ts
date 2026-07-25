import type { AuditEvent, PolicyDecisionType } from "../../contracts/src/index.ts";

const sensitiveKeyPattern = /password|secret|token|api.?key|private.?key|card.?number/i;

export class InMemoryAuditStore {
  private readonly events: AuditEvent[] = [];
  private readonly nextSequenceByTrace = new Map<string, number>();

  append(input: {
    traceId: string;
    actor: string;
    action: string;
    resource: string;
    decision?: PolicyDecisionType;
    payload?: Record<string, unknown>;
  }): AuditEvent {
    const sequence = (this.nextSequenceByTrace.get(input.traceId) ?? 0) + 1;
    this.nextSequenceByTrace.set(input.traceId, sequence);
    const event: AuditEvent = {
      traceId: input.traceId,
      sequence,
      actor: input.actor,
      action: input.action,
      resource: input.resource,
      ...(input.decision ? { decision: input.decision } : {}),
      redactedPayload: this.redactRecord(input.payload ?? {}),
      timestamp: new Date().toISOString(),
    };
    this.events.push(event);
    return event;
  }

  list(traceId?: string): AuditEvent[] {
    return this.events
      .filter((event) => !traceId || event.traceId === traceId)
      .map((event) => structuredClone(event));
  }

  private redactRecord(record: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(record).map(([key, value]) => [
        key,
        sensitiveKeyPattern.test(key) ? "[REDACTED]" : this.redactValue(value),
      ]),
    );
  }

  private redactValue(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.redactValue(item));
    }
    if (typeof value === "object" && value !== null) {
      return this.redactRecord(value as Record<string, unknown>);
    }
    return value;
  }
}

