import type { CreateTaskRequest, ModelAction } from "../packages/contracts/src/index.ts";
import {
  ModelGatewayError,
  ReliableModelGateway,
  type ModelAdapter,
} from "../packages/model-gateway/src/index.ts";

let primaryCalls = 0;
const primary: ModelAdapter = {
  async nextAction(): Promise<ModelAction> {
    primaryCalls += 1;
    throw new ModelGatewayError("private-primary temporarily unavailable", {
      retryable: true,
      code: "HTTP_503",
      status: 503,
    });
  },
};

const fallback: ModelAdapter = {
  async nextAction(): Promise<ModelAction> {
    return {
      type: "TOOL_CALL",
      toolName: "retrieve_context",
      arguments: {
        query: "转账每日累计限额",
        maxResults: 6,
        maxContextChars: 4_000,
      },
      reason: "合规备用模型继续规划只读检索。",
    };
  },
};

const gateway = new ReliableModelGateway({
  providers: [
    {
      id: "bank-private-primary",
      adapter: primary,
      allowedDataClassifications: ["INTERNAL", "CONFIDENTIAL", "RESTRICTED"],
    },
    {
      id: "bank-private-fallback",
      adapter: fallback,
      allowedDataClassifications: ["INTERNAL", "CONFIDENTIAL", "RESTRICTED"],
    },
  ],
  maxAttemptsPerProvider: 2,
  retryBaseDelayMs: 1,
  circuitFailureThreshold: 1,
  onAuditEvent: (event) => {
    console.log(
      `${event.providerId.padEnd(24)} attempt=${event.attempt} outcome=${event.outcome}` +
        `${event.errorCode ? ` error=${event.errorCode}` : ""}`,
    );
  },
});

const request: CreateTaskRequest = {
  idempotencyKey: "model-gateway-demo",
  command: "给转账服务增加每日累计限额",
  workspace: {
    workspaceId: "bank-transfer-demo",
    rootPath: "/server/registered/path",
    repository: "bank-transfer-demo",
    branch: "feature/daily-limit",
    baseRevision: "fixture-v1",
    dataClassification: "RESTRICTED",
  },
};

const action = await gateway.nextAction({ request, observations: [] });
console.log(`primaryCalls=${primaryCalls}`);
console.log("selectedAction=", action);
