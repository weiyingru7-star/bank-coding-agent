import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createAgentServer, WorkspaceRegistry } from "../src/server.ts";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, "../../..");
const fixtureRoot = path.join(projectRoot, "fixtures/bank-transfer-demo");

async function startTestServer() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "bank-agent-server-"));
  const temporaryWorkspace = path.join(temporaryRoot, "bank-transfer-demo");
  await cp(fixtureRoot, temporaryWorkspace, { recursive: true });
  const registry = new WorkspaceRegistry();
  registry.register("bank-transfer-demo", temporaryWorkspace, {
    allowedPathPrefixes: ["src"],
  });
  const { server } = createAgentServer({ registry });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server failed to bind a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    temporaryRoot,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(temporaryRoot, { recursive: true, force: true });
    },
  };
}

function taskBody(idempotencyKey: string) {
  return {
    idempotencyKey,
    command:
      "给转账服务增加每日累计限额校验，超过限额返回统一错误码，记录审计日志，并补充单元测试。",
    workspace: {
      workspaceId: "bank-transfer-demo",
      rootPath: "/client/cannot/choose/server/path",
      repository: "bank-transfer-demo",
      branch: "feature/daily-limit",
      baseRevision: "fixture-v1",
      dataClassification: "PUBLIC",
      currentFile: "src/transfer-service.ts",
    },
  };
}

test("requires an authenticated identity", async () => {
  const context = await startTestServer();
  try {
    const response = await fetch(`${context.baseUrl}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(taskBody("unauthenticated-task")),
    });
    assert.equal(response.status, 401);
  } finally {
    await context.close();
  }
});

test("creates one task per idempotency key, streams events, and enforces reviewer approval", async () => {
  const context = await startTestServer();
  try {
    const create = () =>
      fetch(`${context.baseUrl}/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-user-id": "developer-001",
        },
        body: JSON.stringify(taskBody("server-idempotency-001")),
      });
    const firstResponse = await create();
    const first = await firstResponse.json();
    const secondResponse = await create();
    const second = await secondResponse.json();

    assert.equal(firstResponse.status, 201);
    assert.equal(secondResponse.status, 200);
    assert.equal(first.reused, false);
    assert.equal(second.reused, true);
    assert.equal(first.task.taskId, second.task.taskId);
    assert.equal(first.task.status, "WAITING_APPROVAL");
    assert.equal(
      first.task.workspace.dataClassification,
      "INTERNAL",
      "the server registry must override a forged client classification",
    );

    const streamResponse = await fetch(
      `${context.baseUrl}/tasks/${first.task.taskId}/events`,
      {
        headers: {
          accept: "text/event-stream",
          "x-user-id": "developer-001",
        },
      },
    );
    const streamText = await streamResponse.text();
    assert.match(streamText, /event: APPROVAL_REQUIRED/);

    const deniedApproval = await fetch(
      `${context.baseUrl}/tasks/${first.task.taskId}/approve`,
      {
        method: "POST",
        headers: {
          "x-user-id": "developer-001",
          "x-user-role": "DEVELOPER",
        },
      },
    );
    assert.equal(deniedApproval.status, 403);

    const approvedResponse = await fetch(
      `${context.baseUrl}/tasks/${first.task.taskId}/approve`,
      {
        method: "POST",
        headers: {
          "x-user-id": "reviewer-001",
          "x-user-role": "REVIEWER",
        },
      },
    );
    const approved = await approvedResponse.json();
    assert.equal(approved.task.status, "SUCCEEDED");
    assert.deepEqual(
      approved.testResults.map((result: { exitCode: number }) => result.exitCode),
      [0, 0],
    );

    const auditResponse = await fetch(
      `${context.baseUrl}/tasks/${first.task.taskId}/audit`,
      {
        headers: {
          "x-user-id": "reviewer-001",
          "x-user-role": "REVIEWER",
        },
      },
    );
    const audit = await auditResponse.json();
    assert.ok(
      audit.events.some((event: { action: string }) => event.action === "APPROVAL_GRANTED"),
    );
    const retrievalAudit = audit.events.find(
      (event: { action: string }) => event.action === "CODE_CONTEXT_RETRIEVED",
    );
    assert.ok(retrievalAudit);
    assert.ok(
      retrievalAudit.redactedPayload.sources.every(
        (source: { path: string }) => source.path.startsWith("src/"),
      ),
    );
  } finally {
    await context.close();
  }
});

test("allows only the task owner to cancel a waiting task", async () => {
  const context = await startTestServer();
  try {
    const createdResponse = await fetch(`${context.baseUrl}/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-user-id": "developer-001",
      },
      body: JSON.stringify(taskBody("cancel-task-001")),
    });
    const created = await createdResponse.json();

    const denied = await fetch(
      `${context.baseUrl}/tasks/${created.task.taskId}/cancel`,
      {
        method: "POST",
        headers: { "x-user-id": "developer-002" },
      },
    );
    assert.equal(denied.status, 403);

    const cancelledResponse = await fetch(
      `${context.baseUrl}/tasks/${created.task.taskId}/cancel`,
      {
        method: "POST",
        headers: { "x-user-id": "developer-001" },
      },
    );
    const cancelled = await cancelledResponse.json();
    assert.equal(cancelled.task.status, "CANCELLED");
    assert.ok(cancelled.events.some((event: { type: string }) => event.type === "TASK_CANCELLED"));
  } finally {
    await context.close();
  }
});
