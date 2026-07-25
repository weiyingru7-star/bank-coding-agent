import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CreateTaskRequest } from "../packages/contracts/src/index.ts";
import { AgentRuntime } from "../packages/agent-runtime/src/index.ts";
import { MockBankModel } from "../packages/model-gateway/src/index.ts";
import { BankPolicyEngine } from "../packages/policy-engine/src/index.ts";
import { WorkspaceToolkit } from "../packages/toolkit/src/index.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(projectRoot, "fixtures/bank-transfer-demo");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "bank-agent-demo-"));
const temporaryWorkspace = path.join(temporaryRoot, "bank-transfer-demo");
await cp(fixtureRoot, temporaryWorkspace, { recursive: true });

try {
  const request: CreateTaskRequest = {
    idempotencyKey: "approval-demo-daily-limit",
    command:
      "给转账服务增加每日累计限额校验，超过限额返回统一错误码，记录审计日志，并补充单元测试。",
    workspace: {
      workspaceId: "bank-transfer-demo",
      rootPath: temporaryWorkspace,
      repository: "bank-transfer-demo",
      branch: "feature/daily-limit",
      baseRevision: "fixture-v1",
      currentFile: "src/transfer-service.ts",
    },
  };
  const runtime = new AgentRuntime({
    model: new MockBankModel(),
    toolkit: new WorkspaceToolkit(temporaryWorkspace),
    policy: new BankPolicyEngine(),
  });

  const pending = await runtime.run(request, "developer-001");
  console.log(`Before approval: ${pending.task.status} / ${pending.task.riskLevel}`);
  const completed = await runtime.approve(pending.task.taskId, "reviewer-001");

  console.log("\nApproval and execution events:\n");
  for (const event of completed.events.filter((item) => item.sequence >= 18)) {
    console.log(`${String(event.sequence).padStart(2, "0")}  ${event.type.padEnd(20)} ${event.message}`);
  }
  console.log("\nTest evidence:");
  for (const result of completed.testResults ?? []) {
    console.log(`${result.command}: exitCode=${result.exitCode}, durationMs=${result.durationMs}`);
  }
  console.log(`\nFinal status: ${completed.task.status}`);
  console.log(`Audit events: ${runtime.getAuditEvents(completed.task.taskId).length}`);
  console.log("The original fixture was not modified; this demo used a temporary workspace.");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

