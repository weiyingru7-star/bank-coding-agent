import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, cp, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { CreateTaskRequest } from "../../contracts/src/index.ts";
import { MockBankModel } from "../../model-gateway/src/index.ts";
import { BankPolicyEngine } from "../../policy-engine/src/index.ts";
import { WorkspaceBoundaryError, WorkspaceToolkit } from "../../toolkit/src/index.ts";
import { AgentRuntime } from "../src/index.ts";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, "../../..");
const fixtureRoot = path.join(projectRoot, "fixtures/bank-transfer-demo");

function createRequest(): CreateTaskRequest {
  return {
    idempotencyKey: "lesson-11-daily-limit",
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
}

test("searches and reads real files, proposes a patch, then waits for transaction approval", async () => {
  const targetFile = path.join(fixtureRoot, "src/transfer-service.ts");
  const before = await readFile(targetFile, "utf8");
  const beforeHash = createHash("sha256").update(before).digest("hex");
  const runtime = new AgentRuntime({
    model: new MockBankModel(),
    toolkit: new WorkspaceToolkit(fixtureRoot),
    policy: new BankPolicyEngine(),
  });

  const result = await runtime.run(createRequest(), "developer-001");
  const after = await readFile(targetFile, "utf8");
  const afterHash = createHash("sha256").update(after).digest("hex");

  assert.equal(result.task.status, "WAITING_APPROVAL");
  assert.equal(result.task.riskLevel, "HIGH");
  assert.equal(result.proposal?.edits[0]?.path, "src/transfer-service.ts");
  assert.match(
    result.proposal?.edits[0]?.replacements[0]?.newText ?? "",
    /assertAllowed/,
  );
  assert.match(
    result.proposal?.edits[0]?.replacements[1]?.newText ?? "",
    /recordUsage/,
  );
  assert.deepEqual(
    result.observations.map((item) => item.toolName),
    ["retrieve_context", "search_code", "read_file", "read_file", "propose_patch"],
  );
  const retrieval = result.observations[0]?.result as {
    snippets: Array<{ path: string }>;
    usedChars: number;
    maxContextChars: number;
  };
  assert.ok(
    retrieval.snippets.some((snippet) => snippet.path === "src/transfer-service.ts"),
  );
  assert.ok(retrieval.usedChars <= retrieval.maxContextChars);
  assert.ok(
    runtime
      .getAuditEvents(result.task.taskId)
      .some((event) => event.action === "CODE_CONTEXT_RETRIEVED"),
  );
  assert.ok(result.events.some((event) => event.type === "APPROVAL_REQUIRED"));
  assert.equal(beforeHash, afterHash, "waiting for approval must not modify the source file");
});

test("rejects attempts to read outside the authorized workspace", async () => {
  const toolkit = new WorkspaceToolkit(fixtureRoot);

  await assert.rejects(
    toolkit.readWorkspaceFile({ path: "../outside-secret.txt" }),
    WorkspaceBoundaryError,
  );
});

test("applies an approved patch in a temporary workspace and passes regression and requirement tests", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "bank-agent-approval-"));
  const temporaryWorkspace = path.join(temporaryRoot, "bank-transfer-demo");
  await cp(fixtureRoot, temporaryWorkspace, { recursive: true });

  try {
    const request = createRequest();
    request.workspace.rootPath = temporaryWorkspace;
    const runtime = new AgentRuntime({
      model: new MockBankModel(),
      toolkit: new WorkspaceToolkit(temporaryWorkspace),
      policy: new BankPolicyEngine(),
    });

    const pending = await runtime.run(request, "developer-001");
    const completed = await runtime.approve(pending.task.taskId, "reviewer-001");
    const modified = await readFile(
      path.join(temporaryWorkspace, "src/transfer-service.ts"),
      "utf8",
    );

    assert.equal(completed.task.status, "SUCCEEDED");
    assert.equal(completed.approval?.decision, "APPROVED");
    assert.match(modified, /dailyLimitService\.assertAllowed/);
    assert.match(modified, /dailyLimitService\.recordUsage/);
    assert.deepEqual(
      completed.testResults?.map((result) => result.exitCode),
      [0, 0],
    );
    assert.ok(completed.events.some((event) => event.type === "PATCH_APPLIED"));
    assert.ok(completed.events.some((event) => event.type === "TESTS_COMPLETED"));
    assert.ok(
      runtime
        .getAuditEvents(completed.task.taskId)
        .some((event) => event.action === "APPROVAL_GRANTED"),
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("refuses approval when the source file changed after the proposal was created", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "bank-agent-conflict-"));
  const temporaryWorkspace = path.join(temporaryRoot, "bank-transfer-demo");
  await cp(fixtureRoot, temporaryWorkspace, { recursive: true });

  try {
    const request = createRequest();
    request.workspace.rootPath = temporaryWorkspace;
    const runtime = new AgentRuntime({
      model: new MockBankModel(),
      toolkit: new WorkspaceToolkit(temporaryWorkspace),
      policy: new BankPolicyEngine(),
    });
    const pending = await runtime.run(request, "developer-001");

    await appendFile(
      path.join(temporaryWorkspace, "src/transfer-service.ts"),
      "\n// Developer changed the file while approval was pending.\n",
      "utf8",
    );
    const result = await runtime.approve(pending.task.taskId, "reviewer-001");

    assert.equal(result.task.status, "FAILED");
    assert.match(
      result.events.at(-1)?.message ?? "",
      /File version conflict/,
    );
    assert.ok(!result.events.some((event) => event.type === "PATCH_APPLIED"));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
