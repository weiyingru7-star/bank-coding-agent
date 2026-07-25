import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CreateTaskRequest } from "../packages/contracts/src/index.ts";
import { AgentRuntime } from "../packages/agent-runtime/src/index.ts";
import { MockBankModel } from "../packages/model-gateway/src/index.ts";
import { BankPolicyEngine } from "../packages/policy-engine/src/index.ts";
import { WorkspaceToolkit } from "../packages/toolkit/src/index.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(projectRoot, "fixtures/bank-transfer-demo");

const request: CreateTaskRequest = {
  idempotencyKey: "runtime-demo-daily-limit",
  command:
    "给转账服务增加每日累计限额校验，超过限额返回统一错误码，记录审计日志，并补充单元测试。",
  workspace: {
    workspaceId: "bank-transfer-demo",
    rootPath: fixtureRoot,
    repository: "bank-transfer-demo",
    branch: "feature/daily-limit",
    baseRevision: "fixture-v1",
    currentFile: "src/transfer-service.ts",
  },
};

const runtime = new AgentRuntime({
  model: new MockBankModel(),
  toolkit: new WorkspaceToolkit(fixtureRoot),
  policy: new BankPolicyEngine(),
});

const result = await runtime.run(request, "developer-001");

console.log("Bank Coding Agent Runtime Demo\n");
for (const event of result.events) {
  console.log(`${String(event.sequence).padStart(2, "0")}  ${event.type.padEnd(20)} ${event.message}`);
}

console.log("\nFinal task state:");
console.log(`status=${result.task.status}`);
console.log(`riskLevel=${result.task.riskLevel}`);
console.log(`editedFiles=${result.proposal?.edits.map((edit) => edit.path).join(", ") ?? "none"}`);
console.log("sourceFilesModified=false");

