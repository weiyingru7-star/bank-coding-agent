import type {
  AgentTask,
  CreateTaskRequest,
  PatchProposal,
  RuntimeEvent,
  TestCommandResult,
} from "../../../packages/contracts/src/index.ts";

export interface TaskApiResult {
  task: AgentTask;
  proposal?: PatchProposal;
  events?: RuntimeEvent[];
  testResults?: TestCommandResult[];
}

export interface CreateTaskApiResult {
  reused: boolean;
  task: AgentTask;
  proposal?: PatchProposal;
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class AgentApiClient {
  private readonly baseUrl: string;
  private readonly userId: string;
  private readonly role: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: {
    baseUrl: string;
    userId: string;
    role: string;
    fetchImpl?: FetchLike;
  }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.userId = options.userId;
    this.role = options.role;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async createTask(request: CreateTaskRequest): Promise<CreateTaskApiResult> {
    return this.requestJson("/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  }

  async getTask(taskId: string): Promise<TaskApiResult> {
    return this.requestJson(`/tasks/${encodeURIComponent(taskId)}`);
  }

  async getEvents(taskId: string): Promise<RuntimeEvent[]> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/tasks/${encodeURIComponent(taskId)}/events`,
      {
        headers: this.buildHeaders({ accept: "text/event-stream" }),
      },
    );
    await this.ensureOk(response);
    return parseSseEvents(await response.text());
  }

  async approveTask(taskId: string): Promise<TaskApiResult> {
    return this.requestJson(`/tasks/${encodeURIComponent(taskId)}/approve`, {
      method: "POST",
    });
  }

  async cancelTask(taskId: string): Promise<TaskApiResult> {
    return this.requestJson(`/tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: "POST",
    });
  }

  private async requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: this.buildHeaders(init.headers),
    });
    await this.ensureOk(response);
    return response.json() as Promise<T>;
  }

  private buildHeaders(additional?: HeadersInit): Headers {
    const headers = new Headers(additional);
    headers.set("x-user-id", this.userId);
    headers.set("x-user-role", this.role);
    return headers;
  }

  private async ensureOk(response: Response): Promise<void> {
    if (response.ok) {
      return;
    }
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Agent Server returned HTTP ${response.status}`);
  }
}

export function parseSseEvents(input: string): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  for (const block of input.split(/\r?\n\r?\n/)) {
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length === 0) {
      continue;
    }
    const parsed = JSON.parse(dataLines.join("\n")) as RuntimeEvent;
    events.push(parsed);
  }
  return events;
}

