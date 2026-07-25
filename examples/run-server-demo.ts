import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentServer, WorkspaceRegistry } from "../apps/agent-server/src/server.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(projectRoot, "fixtures/bank-transfer-demo");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "bank-agent-http-demo-"));
const temporaryWorkspace = path.join(temporaryRoot, "bank-transfer-demo");
await cp(fixtureRoot, temporaryWorkspace, { recursive: true });

const registry = new WorkspaceRegistry();
registry.register("bank-transfer-demo", temporaryWorkspace);
const { server } = createAgentServer({ registry });
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Server failed to bind");
}
const baseUrl = `http://127.0.0.1:${address.port}`;
const requestBody = {
  idempotencyKey: "http-demo-001",
  command: "给转账服务增加每日累计限额校验并补充测试。",
  workspace: {
    workspaceId: "bank-transfer-demo",
    rootPath: "/untrusted/client/path",
    repository: "bank-transfer-demo",
    branch: "feature/daily-limit",
    baseRevision: "fixture-v1",
    currentFile: "src/transfer-service.ts",
  },
};

try {
  const createTask = () =>
    fetch(`${baseUrl}/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-user-id": "developer-001",
      },
      body: JSON.stringify(requestBody),
    }).then((response) => response.json());

  const first = await createTask();
  const duplicate = await createTask();
  console.log(`Created task: ${first.task.taskId}`);
  console.log(`State before approval: ${first.task.status}`);
  console.log(`Duplicate request reused task: ${duplicate.reused}`);

  const eventStream = await fetch(`${baseUrl}/tasks/${first.task.taskId}/events`, {
    headers: {
      accept: "text/event-stream",
      "x-user-id": "developer-001",
    },
  }).then((response) => response.text());
  console.log(`SSE contains approval event: ${eventStream.includes("APPROVAL_REQUIRED")}`);

  const approved = await fetch(`${baseUrl}/tasks/${first.task.taskId}/approve`, {
    method: "POST",
    headers: {
      "x-user-id": "reviewer-001",
      "x-user-role": "REVIEWER",
    },
  }).then((response) => response.json());
  console.log(`State after approval: ${approved.task.status}`);
  console.log(
    `Test exit codes: ${approved.testResults.map((result: { exitCode: number }) => result.exitCode).join(", ")}`,
  );
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(temporaryRoot, { recursive: true, force: true });
}

