import assert from "node:assert/strict";
import test from "node:test";

import type { CreateTaskRequest } from "../../../packages/contracts/src/index.ts";
import { AgentApiClient, parseSseEvents } from "../src/agent-api-client.ts";

function sampleRequest(): CreateTaskRequest {
  return {
    idempotencyKey: "extension-test-001",
    command: "增加每日限额校验",
    workspace: {
      workspaceId: "bank-transfer-demo",
      rootPath: "/untrusted/client/path",
      repository: "bank-transfer-demo",
      branch: "feature/daily-limit",
      baseRevision: "fixture-v1",
    },
  };
}

test("sends demo identity headers and the task request", async () => {
  let capturedRequest: { url: string; init: RequestInit | undefined } | undefined;
  const client = new AgentApiClient({
    baseUrl: "http://agent.test/",
    userId: "developer-001",
    role: "DEVELOPER",
    fetchImpl: async (input, init) => {
      capturedRequest = { url: String(input), init };
      return new Response(
        JSON.stringify({
          reused: false,
          task: {
            taskId: "task-001",
            idempotencyKey: "extension-test-001",
            userId: "developer-001",
            command: "增加每日限额校验",
            workspace: sampleRequest().workspace,
            status: "WAITING_APPROVAL",
            riskLevel: "HIGH",
            createdAt: "2026-07-25T00:00:00Z",
            updatedAt: "2026-07-25T00:00:00Z",
          },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    },
  });

  const result = await client.createTask(sampleRequest());

  assert.equal(result.task.status, "WAITING_APPROVAL");
  assert.equal(capturedRequest?.url, "http://agent.test/tasks");
  const headers = new Headers(capturedRequest?.init?.headers);
  assert.equal(headers.get("x-user-id"), "developer-001");
  assert.equal(headers.get("x-user-role"), "DEVELOPER");
  assert.deepEqual(
    JSON.parse(String(capturedRequest?.init?.body)),
    sampleRequest(),
  );
});

test("parses replayed SSE task events in order", () => {
  const input = [
    "id: 1",
    "event: TASK_STARTED",
    'data: {"sequence":1,"type":"TASK_STARTED","message":"started"}',
    "",
    "id: 2",
    "event: APPROVAL_REQUIRED",
    'data: {"sequence":2,"type":"APPROVAL_REQUIRED","message":"review"}',
    "",
  ].join("\n");

  const events = parseSseEvents(input);

  assert.deepEqual(
    events.map((event) => [event.sequence, event.type]),
    [
      [1, "TASK_STARTED"],
      [2, "APPROVAL_REQUIRED"],
    ],
  );
});

test("surfaces an Agent Server error message", async () => {
  const client = new AgentApiClient({
    baseUrl: "http://agent.test",
    userId: "developer-001",
    role: "DEVELOPER",
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: "Only a REVIEWER can approve" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
  });

  await assert.rejects(
    client.approveTask("task-001"),
    /Only a REVIEWER can approve/,
  );
});
