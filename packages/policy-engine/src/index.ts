import type {
  CreateTaskRequest,
  PatchProposal,
  PolicyDecision,
  ToolCall,
} from "../../contracts/src/index.ts";

export class BankPolicyEngine {
  authorizeTool(toolCall: ToolCall, approvalGranted = false): PolicyDecision {
    if (
      ["retrieve_context", "search_code", "read_file", "propose_patch"].includes(
        toolCall.toolName,
      )
    ) {
      return {
        decision: "ALLOW",
        riskLevel: toolCall.toolName === "propose_patch" ? "MEDIUM" : "LOW",
        policyId: "BANK-TOOL-ALLOWLIST-001",
        reason: "该工具没有直接产生工作区写入副作用。",
      };
    }

    if (toolCall.toolName === "apply_patch" && approvalGranted) {
      return {
        decision: "ALLOW",
        riskLevel: "HIGH",
        policyId: "BANK-APPROVED-PATCH-001",
        reason: "高风险补丁已由 Reviewer 审批，可以进入版本校验和安全应用阶段。",
      };
    }

    if (toolCall.toolName === "run_tests") {
      return {
        decision: "ALLOW",
        riskLevel: "MEDIUM",
        policyId: "BANK-TEST-WHITELIST-001",
        reason: "仅允许执行预先登记的测试命令。",
      };
    }

    return {
      decision: "DENY",
      riskLevel: "BLOCKED",
      policyId: "BANK-TOOL-DENY-DEFAULT",
      reason: `当前阶段不允许执行工具 ${toolCall.toolName}。`,
    };
  }

  assessProposal(request: CreateTaskRequest, proposal: PatchProposal): PolicyDecision {
    const modifiesTransferCore = proposal.edits.some((edit) =>
      edit.path.toLocaleLowerCase().includes("transfer-service"),
    );
    const commandMentionsTransactionRisk = /转账|交易|限额|transfer|limit/i.test(request.command);

    if (modifiesTransferCore || commandMentionsTransactionRisk) {
      return {
        decision: "REQUIRE_APPROVAL",
        riskLevel: "HIGH",
        policyId: "BANK-TRANSACTION-CORE-001",
        reason: "修改涉及转账及交易限额核心逻辑，必须由 Reviewer 审批。",
      };
    }

    return {
      decision: "ALLOW",
      riskLevel: "MEDIUM",
      policyId: "BANK-SOURCE-EDIT-001",
      reason: "普通源码补丁可以在用户确认 diff 后继续。",
    };
  }
}
