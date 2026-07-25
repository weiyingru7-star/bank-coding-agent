import { InMemoryTaskQueue } from "../packages/task-scheduler/src/index.ts";

interface DemoPayload {
  command: string;
}

let now = 1_000;
const queue = new InMemoryTaskQueue<DemoPayload, string>({ now: () => now });

queue.enqueue({
  jobId: "task-a-1",
  tenantId: "bank-dev",
  idempotencyKey: "request-a-1",
  resourceKey: "workspace-a",
  payload: { command: "修改转账限额" },
  maxAttempts: 3,
  priority: 10,
});
queue.enqueue({
  jobId: "task-a-2",
  tenantId: "bank-dev",
  idempotencyKey: "request-a-2",
  resourceKey: "workspace-a",
  payload: { command: "修改同一仓库的错误码" },
  maxAttempts: 3,
});
queue.enqueue({
  jobId: "task-b-1",
  tenantId: "bank-dev",
  idempotencyKey: "request-b-1",
  resourceKey: "workspace-b",
  payload: { command: "修改另一个仓库" },
  maxAttempts: 3,
});

const workerOne = queue.leaseNext("worker-1", 1_000);
const workerTwo = queue.leaseNext("worker-2", 1_000);
console.log(`worker-1 leased ${workerOne?.jobId}`);
console.log(`worker-2 leased ${workerTwo?.jobId}`);
console.log("task-a-2 remains READY because workspace-a is already leased");

const snapshot = queue.snapshot();
now += 2_000;
const restarted = new InMemoryTaskQueue<DemoPayload, string>({
  now: () => now,
  snapshot,
});
console.log("recovered after restart:", restarted.recoverExpiredLeases());
console.log("replacement worker leased:", restarted.leaseNext("worker-3", 1_000)?.jobId);
