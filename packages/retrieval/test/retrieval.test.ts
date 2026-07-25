import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { RepositoryRetriever } from "../src/index.ts";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(currentDirectory, "../../../fixtures/bank-transfer-demo");

test("expands a Chinese banking requirement and ranks relevant source code", async () => {
  const retriever = new RepositoryRetriever(fixtureRoot, {
    allowedPathPrefixes: ["src"],
  });

  const result = await retriever.retrieve("给转账增加每日累计限额和审计", {
    maxResults: 5,
    maxContextChars: 4_000,
  });

  assert.ok(result.expandedTerms.includes("transfer"));
  assert.ok(result.expandedTerms.includes("daily"));
  assert.ok(result.expandedTerms.includes("audit"));
  assert.ok(result.snippets.length > 0);
  assert.equal(result.snippets[0]?.path, "src/transfer-service.ts");
  assert.ok(
    result.snippets.some((snippet) => snippet.path === "src/in-memory-services.ts"),
  );
});

test("filters unauthorized paths before ranking", async () => {
  const retriever = new RepositoryRetriever(fixtureRoot, {
    allowedPathPrefixes: ["src"],
  });

  const result = await retriever.retrieve("每日限额验收 requirement", {
    maxResults: 20,
  });

  assert.ok(result.snippets.every((snippet) => snippet.path.startsWith("src/")));
  assert.ok(!result.snippets.some((snippet) => snippet.path.startsWith("requirements/")));
  assert.ok(!result.snippets.some((snippet) => snippet.path === "TASK.md"));
});

test("never assembles more context than the configured character budget", async () => {
  const retriever = new RepositoryRetriever(fixtureRoot);
  const result = await retriever.retrieve("transfer daily limit audit error test", {
    maxResults: 20,
    maxContextChars: 500,
  });

  assert.ok(result.snippets.length > 0);
  assert.equal(result.usedChars, result.renderedContext.length);
  assert.ok(result.usedChars <= 500);
  assert.ok(result.snippets.some((snippet) => snippet.truncated));
});
