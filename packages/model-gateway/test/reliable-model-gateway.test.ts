import assert from "node:assert/strict";
import test from "node:test";

import type {
  CreateTaskRequest,
  DataClassification,
  ModelAction,
} from "../../contracts/src/index.ts";
import {
  ModelGatewayError,
  ReliableModelGateway,
  type ModelAdapter,
  type ModelGatewayAuditEvent,
} from "../src/index.ts";

function createRequest(
  dataClassification: DataClassification = "INTERNAL",
): CreateTaskRequest {
  return {
    idempotencyKey: `gateway-${dataClassification.toLocaleLowerCase()}`,
    command: "分析转账每日累计限额实现",
    workspace: {
      workspaceId: "bank-transfer-demo",
      rootPath: "/server/path",
      repository: "bank-transfer-demo",
      branch: "feature/daily-limit",
      baseRevision: "fixture-v1",
      dataClassification,
    },
  };
}

const finalAction: ModelAction = {
  type: "FINAL",
  summary: "模型调用成功。",
};

function retryableFailure(code = "HTTP_503"): ModelGatewayError {
  return new ModelGatewayError("temporary model failure", {
    retryable: true,
    code,
    status: code === "HTTP_503" ? 503 : undefined,
  });
}

test("retries a transient provider failure with exponential backoff", async () => {
  let calls = 0;
  const delays: number[] = [];
  const audit: ModelGatewayAuditEvent[] = [];
  const adapter: ModelAdapter = {
    async nextAction() {
      calls += 1;
      if (calls === 1) {
        throw retryableFailure();
      }
      return finalAction;
    },
  };
  const gateway = new ReliableModelGateway({
    providers: [
      {
        id: "private-primary",
        adapter,
        allowedDataClassifications: ["INTERNAL", "CONFIDENTIAL", "RESTRICTED"],
      },
    ],
    maxAttemptsPerProvider: 2,
    retryBaseDelayMs: 25,
    sleep: async (delayMs) => {
      delays.push(delayMs);
    },
    onAuditEvent: (event) => audit.push(event),
  });

  const result = await gateway.nextAction({
    request: createRequest(),
    observations: [],
  });

  assert.deepEqual(result, finalAction);
  assert.equal(calls, 2);
  assert.deepEqual(delays, [25]);
  assert.deepEqual(
    audit.map((event) => [event.providerId, event.attempt, event.outcome]),
    [
      ["private-primary", 1, "FAILED"],
      ["private-primary", 2, "SUCCEEDED"],
    ],
  );
  assert.ok(audit.every((event) => /^[a-f0-9]{64}$/.test(event.requestHash)));
});

test("opens a circuit after repeated failure and uses a compliant fallback", async () => {
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const audit: ModelGatewayAuditEvent[] = [];
  const gateway = new ReliableModelGateway({
    providers: [
      {
        id: "private-primary",
        allowedDataClassifications: ["INTERNAL"],
        adapter: {
          async nextAction() {
            primaryCalls += 1;
            throw retryableFailure();
          },
        },
      },
      {
        id: "private-fallback",
        allowedDataClassifications: ["INTERNAL"],
        adapter: {
          async nextAction() {
            fallbackCalls += 1;
            return finalAction;
          },
        },
      },
    ],
    maxAttemptsPerProvider: 1,
    circuitFailureThreshold: 1,
    circuitCooldownMs: 60_000,
    onAuditEvent: (event) => audit.push(event),
  });

  await gateway.nextAction({ request: createRequest(), observations: [] });
  await gateway.nextAction({ request: createRequest(), observations: [] });

  assert.equal(primaryCalls, 1, "the open circuit must skip the unhealthy provider");
  assert.equal(fallbackCalls, 2);
  assert.ok(
    audit.some(
      (event) =>
        event.providerId === "private-primary" && event.outcome === "CIRCUIT_OPEN",
    ),
  );
});

test("never routes restricted code to a provider that is not approved for it", async () => {
  let cloudCalls = 0;
  let privateCalls = 0;
  const gateway = new ReliableModelGateway({
    providers: [
      {
        id: "public-cloud",
        allowedDataClassifications: ["PUBLIC", "INTERNAL"],
        adapter: {
          async nextAction() {
            cloudCalls += 1;
            return finalAction;
          },
        },
      },
      {
        id: "bank-private",
        allowedDataClassifications: [
          "PUBLIC",
          "INTERNAL",
          "CONFIDENTIAL",
          "RESTRICTED",
        ],
        adapter: {
          async nextAction() {
            privateCalls += 1;
            return finalAction;
          },
        },
      },
    ],
  });

  await gateway.nextAction({
    request: createRequest("RESTRICTED"),
    observations: [],
  });

  assert.equal(cloudCalls, 0);
  assert.equal(privateCalls, 1);
});

test("uses another compliant provider when the local request rate limit is reached", async () => {
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const audit: ModelGatewayAuditEvent[] = [];
  const gateway = new ReliableModelGateway({
    providers: [
      {
        id: "primary",
        allowedDataClassifications: ["INTERNAL"],
        adapter: {
          async nextAction() {
            primaryCalls += 1;
            return finalAction;
          },
        },
      },
      {
        id: "fallback",
        allowedDataClassifications: ["INTERNAL"],
        adapter: {
          async nextAction() {
            fallbackCalls += 1;
            return finalAction;
          },
        },
      },
    ],
    rateLimit: { maxRequests: 1, windowMs: 60_000 },
    onAuditEvent: (event) => audit.push(event),
  });

  await gateway.nextAction({ request: createRequest(), observations: [] });
  await gateway.nextAction({ request: createRequest(), observations: [] });

  assert.equal(primaryCalls, 1);
  assert.equal(fallbackCalls, 1);
  assert.ok(
    audit.some(
      (event) => event.providerId === "primary" && event.outcome === "RATE_LIMITED",
    ),
  );
});
