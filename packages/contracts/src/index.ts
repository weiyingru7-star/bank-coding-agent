export const taskStatuses = [
  "PENDING",
  "RUNNING",
  "WAITING_APPROVAL",
  "CANCELLING",
  "CANCELLED",
  "SUCCEEDED",
  "FAILED",
  "TIMED_OUT",
  "RECOVERING",
] as const;

export type TaskStatus = (typeof taskStatuses)[number];

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "BLOCKED";

export type DataClassification = "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED";

export type PolicyDecisionType = "ALLOW" | "DENY" | "REQUIRE_APPROVAL";

export interface WorkspaceContext {
  workspaceId: string;
  rootPath: string;
  repository: string;
  branch: string;
  baseRevision: string;
  dataClassification?: DataClassification;
  currentFile?: string;
  selectedText?: string;
}

export interface CreateTaskRequest {
  idempotencyKey: string;
  command: string;
  workspace: WorkspaceContext;
}

export interface AgentTask {
  taskId: string;
  idempotencyKey: string;
  userId: string;
  command: string;
  workspace: WorkspaceContext;
  status: TaskStatus;
  riskLevel: RiskLevel;
  createdAt: string;
  updatedAt: string;
}

export interface ToolCall<TArguments = Record<string, unknown>> {
  toolCallId: string;
  taskId: string;
  stepId: string;
  toolName:
    | "retrieve_context"
    | "search_code"
    | "read_file"
    | "propose_patch"
    | "apply_patch"
    | "run_tests";
  arguments: TArguments;
}

export interface RetrieveContextArguments {
  query: string;
  maxResults?: number;
  maxContextChars?: number;
}

export interface SearchCodeArguments {
  query: string;
  maxResults?: number;
}

export interface SearchCodeMatch {
  path: string;
  line: number;
  preview: string;
}

export interface ReadFileArguments {
  path: string;
  maxChars?: number;
}

export interface ReadFileResult {
  path: string;
  content: string;
  sha256: string;
  truncated: boolean;
}

export interface TextReplacement {
  oldText: string;
  newText: string;
}

export interface ProposedFileEdit {
  path: string;
  expectedSha256: string;
  replacements: TextReplacement[];
}

export interface PatchProposal {
  summary: string;
  edits: ProposedFileEdit[];
  testCommands: string[];
}

export interface AppliedPatchResult {
  rollbackId: string;
  editedFiles: Array<{
    path: string;
    beforeSha256: string;
    afterSha256: string;
  }>;
}

export interface TestCommandResult {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface AgentObservation {
  toolCallId: string;
  toolName: ToolCall["toolName"];
  result: unknown;
}

export type ModelAction =
  | {
      type: "TOOL_CALL";
      toolName: ToolCall["toolName"];
      arguments: Record<string, unknown>;
      reason: string;
    }
  | {
      type: "FINAL";
      summary: string;
    };

export interface PolicyDecision {
  decision: PolicyDecisionType;
  riskLevel: RiskLevel;
  policyId: string;
  reason: string;
}

export interface Approval {
  approvalId: string;
  taskId: string;
  diffHash: string;
  reason: string;
  requestedBy: string;
  decidedBy?: string;
  decision: "PENDING" | "APPROVED" | "REJECTED";
}

export interface AuditEvent {
  traceId: string;
  sequence: number;
  actor: string;
  action: string;
  resource: string;
  decision?: PolicyDecisionType;
  redactedPayload: Record<string, unknown>;
  timestamp: string;
}

export interface RuntimeEvent {
  sequence: number;
  type:
    | "TASK_STARTED"
    | "MODEL_ACTION"
    | "TOOL_STARTED"
    | "TOOL_COMPLETED"
    | "POLICY_DECISION"
    | "APPROVAL_REQUIRED"
    | "APPROVAL_GRANTED"
    | "PATCH_APPLIED"
    | "TESTS_COMPLETED"
    | "ROLLBACK_COMPLETED"
    | "TASK_CANCELLED"
    | "TASK_COMPLETED"
    | "TASK_FAILED";
  message: string;
  data?: Record<string, unknown>;
}
