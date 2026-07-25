import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { CreateTaskRequest } from "../../../packages/contracts/src/index.ts";
import {
  AuthorizationError,
  NotFoundError,
  TaskService,
  WorkspaceRegistry,
} from "./task-service.ts";

const maxRequestBodyBytes = 1024 * 1024;

export function createAgentServer(options: { registry: WorkspaceRegistry }) {
  const taskService = new TaskService(options.registry);

  const server = createServer(async (request, response) => {
    try {
      await routeRequest(request, response, taskService);
    } catch (error) {
      if (error instanceof AuthorizationError) {
        sendJson(response, 403, { error: error.message });
      } else if (error instanceof NotFoundError) {
        sendJson(response, 404, { error: error.message });
      } else if (error instanceof SyntaxError) {
        sendJson(response, 400, { error: "Invalid JSON request body" });
      } else {
        sendJson(response, 400, {
          error: error instanceof Error ? error.message : "Unknown server error",
        });
      }
    }
  });

  return { server, taskService };
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  taskService: TaskService,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://agent.local");
  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { status: "ok" });
    return;
  }

  const userId = getHeader(request, "x-user-id");
  if (!userId) {
    sendJson(response, 401, { error: "Missing authenticated user identity" });
    return;
  }
  const role = getHeader(request, "x-user-role") ?? "DEVELOPER";

  if (request.method === "POST" && url.pathname === "/tasks") {
    const body = (await readJsonBody(request)) as CreateTaskRequest;
    validateCreateTaskRequest(body);
    const created = await taskService.create(body, userId);
    sendJson(response, created.reused ? 200 : 201, {
      reused: created.reused,
      task: created.result.task,
      proposal: created.result.proposal,
    });
    return;
  }

  const taskMatch = /^\/tasks\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && taskMatch?.[1]) {
    const result = taskService.get(taskMatch[1], userId, role);
    sendJson(response, 200, result);
    return;
  }

  const eventMatch = /^\/tasks\/([^/]+)\/events$/.exec(url.pathname);
  if (request.method === "GET" && eventMatch?.[1]) {
    const events = taskService.getEvents(eventMatch[1], userId, role);
    if ((request.headers.accept ?? "").includes("text/event-stream")) {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      for (const event of events) {
        response.write(`id: ${event.sequence}\n`);
        response.write(`event: ${event.type}\n`);
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      response.end();
    } else {
      sendJson(response, 200, { events });
    }
    return;
  }

  const approvalMatch = /^\/tasks\/([^/]+)\/approve$/.exec(url.pathname);
  if (request.method === "POST" && approvalMatch?.[1]) {
    const result = await taskService.approve(approvalMatch[1], userId, role);
    sendJson(response, 200, result);
    return;
  }

  const cancelMatch = /^\/tasks\/([^/]+)\/cancel$/.exec(url.pathname);
  if (request.method === "POST" && cancelMatch?.[1]) {
    const result = taskService.cancel(cancelMatch[1], userId);
    sendJson(response, 200, result);
    return;
  }

  const auditMatch = /^\/tasks\/([^/]+)\/audit$/.exec(url.pathname);
  if (request.method === "GET" && auditMatch?.[1]) {
    const events = taskService.getAuditEvents(auditMatch[1], userId, role);
    sendJson(response, 200, { events });
    return;
  }

  sendJson(response, 404, { error: "Route not found" });
}

function validateCreateTaskRequest(body: CreateTaskRequest): void {
  if (!body || typeof body !== "object") {
    throw new Error("Request body is required");
  }
  if (!body.idempotencyKey?.trim() || body.idempotencyKey.length > 200) {
    throw new Error("idempotencyKey is required and must be at most 200 characters");
  }
  if (!body.command?.trim() || body.command.length > 5_000) {
    throw new Error("command is required and must be at most 5000 characters");
  }
  if (!body.workspace?.workspaceId?.trim()) {
    throw new Error("workspace.workspaceId is required");
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let body = "";
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > maxRequestBodyBytes) {
      throw new Error("Request body exceeds 1 MiB");
    }
    body += String(chunk);
  }
  return body ? JSON.parse(body) : {};
}

function getHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  if (response.headersSent) {
    return;
  }
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

export { WorkspaceRegistry };

