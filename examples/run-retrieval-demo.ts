import path from "node:path";
import { fileURLToPath } from "node:url";

import { RepositoryRetriever } from "../packages/retrieval/src/index.ts";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(currentDirectory, "../fixtures/bank-transfer-demo");
const retriever = new RepositoryRetriever(fixtureRoot, {
  allowedPathPrefixes: ["src", "requirements", "TASK.md"],
});

const result = await retriever.retrieve("给转账增加每日累计限额、统一错误码和审计", {
  maxResults: 6,
  maxContextChars: 2_500,
});

console.log("原始需求：", result.originalQuery);
console.log("查询扩展：", result.expandedTerms.join(", "));
console.log("上下文预算：", `${result.usedChars}/${result.maxContextChars} 字符`);
console.table(
  result.snippets.map((snippet) => ({
    path: snippet.path,
    lines: `${snippet.startLine}-${snippet.endLine}`,
    score: snippet.score,
    matchedTerms: snippet.matchedTerms.join(", "),
    truncated: snippet.truncated,
  })),
);
