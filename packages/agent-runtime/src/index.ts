import { createHash, randomUUID } from "node:crypto";

import { InMemoryAuditStore } from "../../audit/src/index.ts";
import type {
  AgentObservation,
  AgentTask,
  AppliedPatchResult,
  Approval,
  CreateTaskRequest,
  PatchProposal,
  RuntimeEvent,
  TestCommandResult,
  ToolCall,
} from "../../contracts/src/index.ts";
import type { ModelAdapter } from "../../model-gateway/src/index.ts";
import { BankPolicyEngine } from "../../policy-engine/src/index.ts";
import type { RetrievalResult } from "../../retrieval/src/index.ts";
import { WorkspaceToolkit } from "../../toolkit/src/index.ts";

export interface RuntimeResult {
  task: AgentTask;
  observations: AgentObservation[];
  events: RuntimeEvent[];
  proposal?: PatchProposal;
  approval?: Approval;
  appliedPatch?: AppliedPatchResult;
  testResults?: TestCommandResult[];
}

interface PendingTaskState {
  request: CreateTaskRequest;
  task: AgentTask;
  observations: AgentObservation[];
  events: RuntimeEvent[];
  proposal: PatchProposal;
  nextEventSequence: number;
}

export class AgentRuntime {
  private readonly model: ModelAdapter;
  private readonly toolkit: WorkspaceToolkit;
  private readonly policy: BankPolicyEngine;
  private readonly audit: InMemoryAuditStore;
  private readonly maxTurns: number;
  private readonly pendingApprovals = new Map<string, PendingTaskState>();

  constructor(options: {
    model: ModelAdapter;
    toolkit: WorkspaceToolkit;
    policy: BankPolicyEngine;
    audit?: InMemoryAuditStore;
    maxTurns?: number;
  }) {
    this.model = options.model;
    this.toolkit = options.toolkit;
    this.policy = options.policy;
    this.audit = options.audit ?? new InMemoryAuditStore();
    this.maxTurns = options.maxTurns ?? 10;
  }

  async run(request: CreateTaskRequest, userId: string): Promise<RuntimeResult> {
    const now = new Date().toISOString();
    const state: Omit<PendingTaskState, "proposal"> = {
      request,
      task: {
        taskId: randomUUID(),
        idempotencyKey: request.idempotencyKey,
        userId,
        command: request.command,
        workspace: request.workspace,
        status: "RUNNING",
        riskLevel: "LOW",
        createdAt: now,
        updatedAt: now,
      },
      observations: [],
      events: [],
      nextEventSequence: 0,
    };

    this.emit(state, "TASK_STARTED", "Agent 任务开始执行。", { taskId: state.task.taskId });
    this.audit.append({
      traceId: state.task.taskId,
      actor: userId,
      action: "TASK_STARTED",
      resource: request.workspace.workspaceId,
      payload: { command: request.command, branch: request.workspace.branch },
    });

    try {
      for (let turn = 1; turn <= this.maxTurns; turn += 1) {
        const action = await this.model.nextAction({
          request,
          observations: state.observations,
        });
        this.emit(
          state,
          "MODEL_ACTION",
          action.type === "TOOL_CALL" ? action.reason : action.summary,
          { turn, actionType: action.type },
        );

        if (action.type === "FINAL") {
          state.task.status = "SUCCEEDED";
          state.task.updatedAt = new Date().toISOString();
          this.emit(state, "TASK_COMPLETED", action.summary);
          return this.toResult(state);
        }

        const toolCall = this.createToolCall(state.task.taskId, turn, action.toolName, action.arguments);
        const authorization = this.policy.authorizeTool(toolCall);
        this.emit(state, "POLICY_DECISION", authorization.reason, {
          toolName: toolCall.toolName,
          decision: authorization.decision,
          policyId: authorization.policyId,
        });
        this.audit.append({
          traceId: state.task.taskId,
          actor: userId,
          action: "TOOL_AUTHORIZATION",
          resource: toolCall.toolName,
          decision: authorization.decision,
          payload: { policyId: authorization.policyId, riskLevel: authorization.riskLevel },
        });

        if (authorization.decision !== "ALLOW") {
          throw new Error(`Tool call denied: ${authorization.reason}`);
        }

        this.emit(state, "TOOL_STARTED", `开始执行工具 ${toolCall.toolName}。`, {
          toolName: toolCall.toolName,
        });
        const result = await this.executeTool(toolCall);
        state.observations.push({
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          result,
        });
        if (toolCall.toolName === "retrieve_context") {
          const retrieval = result as RetrievalResult;
          const query = String(toolCall.arguments.query ?? "");
          this.audit.append({
            traceId: state.task.taskId,
            actor: userId,
            action: "CODE_CONTEXT_RETRIEVED",
            resource: request.workspace.workspaceId,
            decision: "ALLOW",
            payload: {
              queryHash: createHash("sha256").update(query).digest("hex"),
              snippetCount: retrieval.snippets.length,
              usedChars: retrieval.usedChars,
              maxContextChars: retrieval.maxContextChars,
              sources: retrieval.snippets.map((snippet) => ({
                path: snippet.path,
                startLine: snippet.startLine,
                endLine: snippet.endLine,
                score: snippet.score,
              })),
            },
          });
        }
        this.emit(state, "TOOL_COMPLETED", `工具 ${toolCall.toolName} 执行完成。`, {
          toolName: toolCall.toolName,
          ...(toolCall.toolName === "retrieve_context"
            ? {
                snippetCount: (result as RetrievalResult).snippets.length,
                usedChars: (result as RetrievalResult).usedChars,
              }
            : {}),
        });

        if (toolCall.toolName === "propose_patch") {
          const proposal = result as PatchProposal;
          const riskDecision = this.policy.assessProposal(request, proposal);
          state.task.riskLevel = riskDecision.riskLevel;
          this.emit(state, "POLICY_DECISION", riskDecision.reason, {
            decision: riskDecision.decision,
            policyId: riskDecision.policyId,
          });

          if (riskDecision.decision === "REQUIRE_APPROVAL") {
            state.task.status = "WAITING_APPROVAL";
            state.task.updatedAt = new Date().toISOString();
            this.emit(state, "APPROVAL_REQUIRED", riskDecision.reason, {
              proposalSummary: proposal.summary,
              editedFiles: proposal.edits.map((edit) => edit.path),
            });
            this.pendingApprovals.set(state.task.taskId, { ...state, proposal });
            this.audit.append({
              traceId: state.task.taskId,
              actor: "policy-engine",
              action: "APPROVAL_REQUIRED",
              resource: request.workspace.workspaceId,
              decision: riskDecision.decision,
              payload: {
                policyId: riskDecision.policyId,
                editedFiles: proposal.edits.map((edit) => edit.path),
              },
            });
            return this.toResult(state, proposal);
          }
        }
      }

      throw new Error(`Agent exceeded maximum turn count: ${this.maxTurns}`);
    } catch (error) {
      return this.failState(state, error);
    }
  }

  async approve(taskId: string, reviewerId: string): Promise<RuntimeResult> {
    const state = this.pendingApprovals.get(taskId);
    if (!state) {
      throw new Error(`Pending approval task not found: ${taskId}`);
    }

    const diffHash = createHash("sha256")
      .update(JSON.stringify(state.proposal))
      .digest("hex");
    const approval: Approval = {
      approvalId: randomUUID(),
      taskId,
      diffHash,
      reason: "Reviewer approved the transaction core change after reviewing the proposal.",
      requestedBy: state.task.userId,
      decidedBy: reviewerId,
      decision: "APPROVED",
    };

    state.task.status = "RUNNING";
    state.task.updatedAt = new Date().toISOString();
    this.emit(state, "APPROVAL_GRANTED", "Reviewer 已批准高风险补丁。", {
      reviewerId,
      diffHash,
    });
    this.audit.append({
      traceId: taskId,
      actor: reviewerId,
      action: "APPROVAL_GRANTED",
      resource: state.request.workspace.workspaceId,
      decision: "ALLOW",
      payload: { approvalId: approval.approvalId, diffHash },
    });

    let appliedPatch: AppliedPatchResult | undefined;
    try {
      const applyCall = this.createToolCall(taskId, 100, "apply_patch", {
        proposal: state.proposal,
        approvalId: approval.approvalId,
      });
      const applyDecision = this.policy.authorizeTool(applyCall, true);
      this.emit(state, "POLICY_DECISION", applyDecision.reason, {
        decision: applyDecision.decision,
        policyId: applyDecision.policyId,
      });
      if (applyDecision.decision !== "ALLOW") {
        throw new Error(`Approved patch denied: ${applyDecision.reason}`);
      }

      appliedPatch = await this.toolkit.applyProposal(state.proposal);
      this.emit(state, "PATCH_APPLIED", "补丁已通过版本校验和 dry-run，并写入工作区。", {
        editedFiles: appliedPatch.editedFiles.map((file) => file.path),
      });
      this.audit.append({
        traceId: taskId,
        actor: state.task.userId,
        action: "PATCH_APPLIED",
        resource: state.request.workspace.workspaceId,
        decision: "ALLOW",
        payload: {
          approvalId: approval.approvalId,
          editedFiles: appliedPatch.editedFiles,
        },
      });

      const testCall = this.createToolCall(taskId, 101, "run_tests", {
        commands: state.proposal.testCommands,
      });
      const testDecision = this.policy.authorizeTool(testCall);
      if (testDecision.decision !== "ALLOW") {
        throw new Error(`Test execution denied: ${testDecision.reason}`);
      }
      const testResults = await this.toolkit.runTestCommands(state.proposal.testCommands);
      const testsPassed = testResults.every(
        (result) => result.exitCode === 0 && !result.timedOut,
      );
      this.emit(state, "TESTS_COMPLETED", testsPassed ? "所有验收测试通过。" : "测试失败。", {
        commands: testResults.map((result) => ({
          command: result.command,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
        })),
      });

      if (!testsPassed) {
        await this.toolkit.rollbackPatch(appliedPatch.rollbackId);
        this.emit(state, "ROLLBACK_COMPLETED", "测试失败，已恢复修改前文件内容。");
        throw new Error("Patch validation tests failed and changes were rolled back");
      }

      state.task.status = "SUCCEEDED";
      state.task.updatedAt = new Date().toISOString();
      this.emit(state, "TASK_COMPLETED", "补丁已审批、应用并通过全部测试。");
      this.audit.append({
        traceId: taskId,
        actor: "agent-runtime",
        action: "TASK_COMPLETED",
        resource: state.request.workspace.workspaceId,
        decision: "ALLOW",
        payload: {
          testResults: testResults.map((result) => ({
            command: result.command,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
          })),
        },
      });
      this.pendingApprovals.delete(taskId);
      return {
        ...this.toResult(state, state.proposal),
        approval,
        appliedPatch,
        testResults,
      };
    } catch (error) {
      this.pendingApprovals.delete(taskId);
      const failed = this.failState(state, error);
      return { ...failed, approval, ...(appliedPatch ? { appliedPatch } : {}) };
    }
  }

  cancel(taskId: string, actorId: string): RuntimeResult {
    const state = this.pendingApprovals.get(taskId);
    if (!state) {
      throw new Error(`Cancellable task not found: ${taskId}`);
    }
    state.task.status = "CANCELLED";
    state.task.updatedAt = new Date().toISOString();
    this.emit(state, "TASK_CANCELLED", "用户已取消任务，待审批补丁不会被应用。", {
      actorId,
    });
    this.audit.append({
      traceId: taskId,
      actor: actorId,
      action: "TASK_CANCELLED",
      resource: state.request.workspace.workspaceId,
      decision: "DENY",
      payload: { previousStatus: "WAITING_APPROVAL" },
    });
    this.pendingApprovals.delete(taskId);
    return this.toResult(state, state.proposal);
  }

  getAuditEvents(taskId?: string) {
    return this.audit.list(taskId);
  }

  private async executeTool(toolCall: ToolCall): Promise<unknown> {
    switch (toolCall.toolName) {
      case "retrieve_context":
        return this.toolkit.retrieveContext(
          toolCall.arguments as unknown as Parameters<WorkspaceToolkit["retrieveContext"]>[0],
        );
      case "search_code":
        return this.toolkit.searchCode(
          toolCall.arguments as unknown as Parameters<WorkspaceToolkit["searchCode"]>[0],
        );
      case "read_file":
        return this.toolkit.readWorkspaceFile(
          toolCall.arguments as unknown as Parameters<WorkspaceToolkit["readWorkspaceFile"]>[0],
        );
      case "propose_patch": {
        const proposal = toolCall.arguments.proposal;
        if (!proposal || typeof proposal !== "object") {
          throw new Error("propose_patch requires a proposal object");
        }
        return this.toolkit.validateProposal(proposal as PatchProposal);
      }
      default:
        throw new Error(`Tool is not implemented in the planning phase: ${toolCall.toolName}`);
    }
  }

  private createToolCall(
    taskId: string,
    stepNumber: number,
    toolName: ToolCall["toolName"],
    arguments_: Record<string, unknown>,
  ): ToolCall {
    return {
      toolCallId: randomUUID(),
      taskId,
      stepId: `step-${stepNumber}`,
      toolName,
      arguments: arguments_,
    };
  }

  private emit(
    state: {
      events: RuntimeEvent[];
      nextEventSequence: number;
    },
    type: RuntimeEvent["type"],
    message: string,
    data?: Record<string, unknown>,
  ) {
    state.nextEventSequence += 1;
    state.events.push({
      sequence: state.nextEventSequence,
      type,
      message,
      ...(data ? { data } : {}),
    });
  }

  private failState(
    state: Omit<PendingTaskState, "proposal"> | PendingTaskState,
    error: unknown,
  ): RuntimeResult {
    state.task.status = "FAILED";
    state.task.updatedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : "Unknown runtime error";
    this.emit(state, "TASK_FAILED", message);
    this.audit.append({
      traceId: state.task.taskId,
      actor: "agent-runtime",
      action: "TASK_FAILED",
      resource: state.request.workspace.workspaceId,
      decision: "DENY",
      payload: { error: message },
    });
    return this.toResult(state, "proposal" in state ? state.proposal : undefined);
  }

  private toResult(
    state: Omit<PendingTaskState, "proposal"> | PendingTaskState,
    proposal?: PatchProposal,
  ): RuntimeResult {
    return {
      task: state.task,
      observations: state.observations,
      events: state.events,
      ...(proposal ? { proposal } : {}),
    };
  }
}
