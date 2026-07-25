import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryTaskQueue,
  QueueLeaseError,
  QueueWorker,
} from "../src/index.ts";

interface Payload {
  command: string;
}

function enqueue(
  queue: InMemoryTaskQueue<Payload, string>,
  options: {
    jobId: string;
    idempotencyKey?: string;
    resourceKey?: string;
    maxAttempts?: number;
    priority?: number;
  },
) {
  return queue.enqueue({
    jobId: options.jobId,
    tenantId: "bank-dev",
    idempotencyKey: options.idempotencyKey ?? options.jobId,
    resourceKey: options.resourceKey ?? "workspace-a",
    payload: { command: `run ${options.jobId}` },
    maxAttempts: options.maxAttempts,
    priority: options.priority,
  });
}

test("reuses the same job for a tenant-scoped idempotency key", () => {
  const queue = new InMemoryTaskQueue<Payload, string>();
  const first = enqueue(queue, {
    jobId: "job-1",
    idempotencyKey: "same-request",
  });
  const second = enqueue(queue, {
    jobId: "job-2",
    idempotencyKey: "same-request",
  });

  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.job.jobId, "job-1");
});

test("allows parallel workspaces but only one active lease per workspace", () => {
  const queue = new InMemoryTaskQueue<Payload, string>();
  enqueue(queue, { jobId: "workspace-a-1", resourceKey: "workspace-a", priority: 10 });
  enqueue(queue, { jobId: "workspace-a-2", resourceKey: "workspace-a" });
  enqueue(queue, { jobId: "workspace-b-1", resourceKey: "workspace-b" });

  assert.equal(queue.leaseNext("worker-1")?.jobId, "workspace-a-1");
  assert.equal(
    queue.leaseNext("worker-2")?.jobId,
    "workspace-b-1",
    "a second worker must skip the already leased workspace",
  );
  assert.equal(queue.leaseNext("worker-3"), undefined);
});

test("only the lease owner can heartbeat or complete a job", () => {
  let now = 1_000;
  const queue = new InMemoryTaskQueue<Payload, string>({ now: () => now });
  enqueue(queue, { jobId: "job-1" });
  const leased = queue.leaseNext("worker-1", 2_000);
  now += 500;
  const heartbeat = queue.heartbeat("job-1", "worker-1", 2_000);

  assert.ok((heartbeat.leaseExpiresAt ?? 0) > (leased?.leaseExpiresAt ?? 0));
  assert.throws(
    () => queue.complete("job-1", "worker-2", "forged"),
    QueueLeaseError,
  );
});

test("recovers an expired lease and lets another worker continue after restart", () => {
  let now = 10_000;
  const queue = new InMemoryTaskQueue<Payload, string>({ now: () => now });
  enqueue(queue, { jobId: "recover-me", maxAttempts: 3 });
  queue.leaseNext("crashed-worker", 1_000);
  const snapshot = queue.snapshot();

  now += 2_000;
  const restarted = new InMemoryTaskQueue<Payload, string>({
    now: () => now,
    snapshot,
  });
  assert.deepEqual(restarted.recoverExpiredLeases(), ["recover-me"]);
  const recovered = restarted.leaseNext("replacement-worker", 1_000);

  assert.equal(recovered?.jobId, "recover-me");
  assert.equal(recovered?.attempts, 2);
});

test("schedules retry with backoff and eventually sends a poison job to dead letter", () => {
  let now = 20_000;
  const queue = new InMemoryTaskQueue<Payload, string>({ now: () => now });
  enqueue(queue, { jobId: "poison", maxAttempts: 2 });
  queue.leaseNext("worker-1");
  const retry = queue.fail("poison", "worker-1", {
    errorCode: "HTTP 503 contains unsafe details",
    retryable: true,
    retryDelayMs: 500,
  });

  assert.equal(retry.status, "READY");
  assert.equal(retry.lastErrorCode, "HTTP_503_contains_unsafe_details");
  assert.equal(queue.leaseNext("worker-2"), undefined);
  now += 500;
  queue.leaseNext("worker-2");
  const dead = queue.fail("poison", "worker-2", {
    errorCode: "HTTP_503",
    retryable: true,
  });
  assert.equal(dead.status, "DEAD_LETTER");
});

test("turns cancellation into a cooperative signal for a leased worker", async () => {
  const queue = new InMemoryTaskQueue<Payload, string>();
  enqueue(queue, { jobId: "cancel-me" });
  const worker = new QueueWorker({
    workerId: "worker-1",
    queue,
    handler: async (_payload, context) => {
      queue.requestCancel(context.jobId);
      assert.equal(context.isCancellationRequested(), true);
      return "ignored-result";
    },
  });

  const result = await worker.runOnce();
  assert.equal(result?.status, "CANCELLED");
  assert.equal(result?.result, undefined);
});

test("worker classifies transient failures and applies attempt-based backoff", async () => {
  let now = 30_000;
  const queue = new InMemoryTaskQueue<Payload, string>({ now: () => now });
  enqueue(queue, { jobId: "worker-retry", maxAttempts: 3 });
  const worker = new QueueWorker({
    workerId: "worker-1",
    queue,
    handler: async () => {
      throw new TypeError("temporary");
    },
    isRetryable: (error) => error instanceof TypeError,
    retryDelayMs: (attempt) => attempt * 1_000,
  });

  const result = await worker.runOnce();
  assert.equal(result?.status, "READY");
  assert.equal(result?.availableAt, now + 1_000);
  assert.ok(
    queue
      .listEvents("worker-retry")
      .some((event) => event.type === "RETRY_SCHEDULED"),
  );
});
