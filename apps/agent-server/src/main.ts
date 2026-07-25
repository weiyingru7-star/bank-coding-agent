import path from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentServer, WorkspaceRegistry } from "./server.ts";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, "../../..");
const workspaceId = process.env.BANK_AGENT_WORKSPACE_ID ?? "bank-transfer-demo";
const workspaceRoot =
  process.env.BANK_AGENT_WORKSPACE_ROOT ??
  path.join(projectRoot, "fixtures/bank-transfer-demo");
const host = process.env.BANK_AGENT_HOST ?? "127.0.0.1";
const port = Number(process.env.BANK_AGENT_PORT ?? "8787");

if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid BANK_AGENT_PORT: ${process.env.BANK_AGENT_PORT}`);
}

const registry = new WorkspaceRegistry();
registry.register(workspaceId, workspaceRoot);
const { server } = createAgentServer({ registry });

server.listen(port, host, () => {
  console.log(`Bank Coding Agent Server: http://${host}:${port}`);
  console.log(`Registered workspace: ${workspaceId} -> ${path.resolve(workspaceRoot)}`);
  console.log("Demo authentication headers are enabled. Do not use this mode in production.");
});

