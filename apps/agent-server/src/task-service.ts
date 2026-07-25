import path from "node:path";

import type {
  CreateTaskRequest,
  DataClassification,
  RuntimeEvent,
} from "../../../packages/contracts/src/index.ts";
import { AgentRuntime, type RuntimeResult } from "../../../packages/agent-runtime/src/index.ts";
import { MockBankModel } from "../../../packages/model-gateway/src/index.ts";
import { BankPolicyEngine } from "../../../packages/policy-engine/src/index.ts";
import type { RetrievalPolicy } from "../../../packages/retrieval/src/index.ts";
import { WorkspaceToolkit } from "../../../packages/toolkit/src/index.ts";

interface ManagedTask {
  ownerId: string;
  runtime: AgentRuntime;
  result: RuntimeResult;
}

export class WorkspaceRegistry {
  private readonly workspaces = new Map<
    string,
    {
      rootPath: string;
      retrievalPolicy: RetrievalPolicy;
      dataClassification: DataClassification;
    }
  >();

  register(
    workspaceId: string,
    rootPath: string,
    retrievalPolicy: RetrievalPolicy = {},
    dataClassification: DataClassification = "INTERNAL",
  ): void {
    this.workspaces.set(workspaceId, {
      rootPath: path.resolve(rootPath),
      retrievalPolicy: structuredClone(retrievalPolicy),
      dataClassification,
    });
  }

  resolve(workspaceId: string): string {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace is not registered: ${workspaceId}`);
    }
    return workspace.rootPath;
  }

  resolveRetrievalPolicy(workspaceId: string): RetrievalPolicy {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace is not registered: ${workspaceId}`);
    }
    return structuredClone(workspace.retrievalPolicy);
  }

  resolveDataClassification(workspaceId: string): DataClassification {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace is not registered: ${workspaceId}`);
    }
    return workspace.dataClassification;
  }
}

export class TaskService {
  private readonly registry: WorkspaceRegistry;
  private readonly tasks = new Map<string, ManagedTask>();
  private readonly idempotencyIndex = new Map<string, string>();

  constructor(registry: WorkspaceRegistry) {
    this.registry = registry;
  }

  async create(
    requestInput: CreateTaskRequest,
    userId: string,
  ): Promise<{ result: RuntimeResult; reused: boolean }> {
    const idempotencyIndexKey = `${userId}:${requestInput.idempotencyKey}`;
    const existingTaskId = this.idempotencyIndex.get(idempotencyIndexKey);
    if (existingTaskId) {
      const existing = this.tasks.get(existingTaskId);
      if (existing) {
        return { result: existing.result, reused: true };
      }
    }

    const registeredRoot = this.registry.resolve(requestInput.workspace.workspaceId);
    const retrievalPolicy = this.registry.resolveRetrievalPolicy(
      requestInput.workspace.workspaceId,
    );
    const dataClassification = this.registry.resolveDataClassification(
      requestInput.workspace.workspaceId,
    );
    const request: CreateTaskRequest = {
      ...requestInput,
      workspace: {
        ...requestInput.workspace,
        rootPath: registeredRoot,
        dataClassification,
      },
    };
    const runtime = new AgentRuntime({
      model: new MockBankModel(),
      toolkit: new WorkspaceToolkit(registeredRoot, retrievalPolicy),
      policy: new BankPolicyEngine(),
    });
    const result = await runtime.run(request, userId);
    this.tasks.set(result.task.taskId, { ownerId: userId, runtime, result });
    this.idempotencyIndex.set(idempotencyIndexKey, result.task.taskId);
    return { result, reused: false };
  }

  get(taskId: string, userId: string, role: string): RuntimeResult {
    const managed = this.requireVisibleTask(taskId, userId, role);
    return managed.result;
  }

  getEvents(taskId: string, userId: string, role: string): RuntimeEvent[] {
    return this.get(taskId, userId, role).events;
  }

  async approve(taskId: string, reviewerId: string, role: string): Promise<RuntimeResult> {
    if (role !== "REVIEWER") {
      throw new AuthorizationError("Only a REVIEWER can approve a high-risk patch");
    }
    const managed = this.tasks.get(taskId);
    if (!managed) {
      throw new NotFoundError(`Task not found: ${taskId}`);
    }
    managed.result = await managed.runtime.approve(taskId, reviewerId);
    return managed.result;
  }

  cancel(taskId: string, userId: string): RuntimeResult {
    const managed = this.tasks.get(taskId);
    if (!managed) {
      throw new NotFoundError(`Task not found: ${taskId}`);
    }
    if (managed.ownerId !== userId) {
      throw new AuthorizationError("Only the task owner can cancel it");
    }
    managed.result = managed.runtime.cancel(taskId, userId);
    return managed.result;
  }

  getAuditEvents(taskId: string, userId: string, role: string) {
    const managed = this.requireVisibleTask(taskId, userId, role);
    return managed.runtime.getAuditEvents(taskId);
  }

  private requireVisibleTask(taskId: string, userId: string, role: string): ManagedTask {
    const managed = this.tasks.get(taskId);
    if (!managed) {
      throw new NotFoundError(`Task not found: ${taskId}`);
    }
    if (managed.ownerId !== userId && role !== "REVIEWER") {
      throw new AuthorizationError("The task is not visible to this user");
    }
    return managed;
  }
}

export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}
