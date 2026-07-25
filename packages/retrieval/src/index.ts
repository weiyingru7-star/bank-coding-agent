import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const searchableExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".java",
  ".kt",
  ".py",
  ".go",
  ".rs",
  ".md",
  ".json",
  ".yaml",
  ".yml",
]);

const excludedDirectories = new Set([".git", "node_modules", "dist", "coverage", ".agent"]);

export interface RetrievalPolicy {
  /**
   * Only paths below these workspace-relative prefixes may enter the index.
   * An empty list means the whole authorized workspace.
   */
  allowedPathPrefixes?: string[];
  deniedPathPrefixes?: string[];
}

export interface RetrievalOptions {
  maxResults?: number;
  maxContextChars?: number;
  chunkLines?: number;
  overlapLines?: number;
}

export interface RetrievalSnippet {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  content: string;
  matchedTerms: string[];
  truncated: boolean;
}

export interface RetrievalResult {
  originalQuery: string;
  expandedTerms: string[];
  snippets: RetrievalSnippet[];
  renderedContext: string;
  usedChars: number;
  maxContextChars: number;
}

interface CodeChunk {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  termFrequency: Map<string, number>;
}

const domainExpansions: Array<{ pattern: RegExp; terms: string[] }> = [
  { pattern: /转账|交易/i, terms: ["transfer", "transaction", "debit"] },
  { pattern: /每日|单日|累计|限额/i, terms: ["daily", "limit", "usage", "quota"] },
  { pattern: /审计/i, terms: ["audit", "log", "record"] },
  { pattern: /错误码|报错/i, terms: ["error", "code", "rejection"] },
  { pattern: /测试|验收/i, terms: ["test", "requirement", "assert"] },
];

export class RepositoryRetriever {
  readonly workspaceRoot: string;
  private readonly policy: RetrievalPolicy;

  constructor(workspaceRoot: string, policy: RetrievalPolicy = {}) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.policy = {
      allowedPathPrefixes: normalizePrefixes(policy.allowedPathPrefixes),
      deniedPathPrefixes: normalizePrefixes(policy.deniedPathPrefixes),
    };
  }

  async retrieve(queryInput: string, options: RetrievalOptions = {}): Promise<RetrievalResult> {
    const query = queryInput.trim();
    if (!query) {
      throw new Error("retrieval query cannot be empty");
    }

    const chunkLines = clamp(options.chunkLines ?? 32, 8, 200);
    const overlapLines = clamp(options.overlapLines ?? 8, 0, chunkLines - 1);
    const maxResults = clamp(options.maxResults ?? 8, 1, 50);
    const maxContextChars = clamp(options.maxContextChars ?? 8_000, 200, 100_000);
    const expandedTerms = expandQuery(query);
    const files = await this.collectAuthorizedFiles(this.workspaceRoot);
    const chunks = (
      await Promise.all(files.map((file) => this.chunkFile(file, chunkLines, overlapLines)))
    ).flat();
    const documentFrequency = calculateDocumentFrequency(chunks);
    const averageLength =
      chunks.length === 0
        ? 1
        : chunks.reduce((sum, chunk) => sum + termCount(chunk.termFrequency), 0) /
          chunks.length;

    const rankedByScore = chunks
      .map((chunk) => scoreChunk(chunk, expandedTerms, documentFrequency, chunks.length, averageLength))
      .filter((item) => item.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.chunk.path.localeCompare(right.chunk.path) ||
          left.chunk.startLine - right.chunk.startLine,
      );
    const ranked = diversifyPaths(rankedByScore).slice(0, maxResults);

    return assembleContext(query, expandedTerms, ranked, maxContextChars);
  }

  private async chunkFile(
    absolutePath: string,
    chunkLines: number,
    overlapLines: number,
  ): Promise<CodeChunk[]> {
    const content = await readFile(absolutePath, "utf8");
    const lines = content.split(/\r?\n/);
    const relativePath = toPosixPath(path.relative(this.workspaceRoot, absolutePath));
    const chunks: CodeChunk[] = [];
    const step = chunkLines - overlapLines;

    for (let start = 0; start < lines.length; start += step) {
      const selectedLines = lines.slice(start, start + chunkLines);
      const chunkContent = selectedLines.join("\n").trimEnd();
      if (chunkContent.trim()) {
        chunks.push({
          path: relativePath,
          startLine: start + 1,
          endLine: Math.min(start + selectedLines.length, lines.length),
          content: chunkContent,
          termFrequency: frequencyMap(tokenize(`${relativePath} ${chunkContent}`)),
        });
      }
      if (start + chunkLines >= lines.length) {
        break;
      }
    }
    return chunks;
  }

  private async collectAuthorizedFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isDirectory() && excludedDirectories.has(entry.name)) {
        continue;
      }

      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await this.collectAuthorizedFiles(absolutePath)));
      } else if (
        entry.isFile() &&
        searchableExtensions.has(path.extname(entry.name)) &&
        this.isAuthorized(absolutePath)
      ) {
        files.push(absolutePath);
      }
    }
    return files;
  }

  private isAuthorized(absolutePath: string): boolean {
    const relativePath = toPosixPath(path.relative(this.workspaceRoot, absolutePath));
    const allowed = this.policy.allowedPathPrefixes ?? [];
    const denied = this.policy.deniedPathPrefixes ?? [];

    if (denied.some((prefix) => isBelowPrefix(relativePath, prefix))) {
      return false;
    }
    return allowed.length === 0 || allowed.some((prefix) => isBelowPrefix(relativePath, prefix));
  }
}

function diversifyPaths<T extends { chunk: { path: string } }>(ranked: T[]): T[] {
  const firstPerPath: T[] = [];
  const remaining: T[] = [];
  const seenPaths = new Set<string>();

  for (const item of ranked) {
    if (seenPaths.has(item.chunk.path)) {
      remaining.push(item);
    } else {
      seenPaths.add(item.chunk.path);
      firstPerPath.push(item);
    }
  }
  return [...firstPerPath, ...remaining];
}

function expandQuery(query: string): string[] {
  const terms = new Set(tokenize(query));
  for (const expansion of domainExpansions) {
    if (expansion.pattern.test(query)) {
      expansion.terms.forEach((term) => terms.add(term));
    }
  }
  return [...terms];
}

function tokenize(value: string): string[] {
  const camelCaseSeparated = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return camelCaseSeparated
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .flatMap((term) => term.split("_"))
    .map((term) => term.trim())
    .filter((term) => term.length > 1);
}

function scoreChunk(
  chunk: CodeChunk,
  queryTerms: string[],
  documentFrequency: Map<string, number>,
  documentCount: number,
  averageLength: number,
): { chunk: CodeChunk; score: number; matchedTerms: string[] } {
  const k1 = 1.2;
  const b = 0.75;
  const length = termCount(chunk.termFrequency);
  const matchedTerms: string[] = [];
  let score = 0;

  for (const term of queryTerms) {
    const frequency = chunk.termFrequency.get(term) ?? 0;
    if (frequency === 0) {
      continue;
    }
    matchedTerms.push(term);
    const matchingDocuments = documentFrequency.get(term) ?? 0;
    const inverseDocumentFrequency = Math.log(
      1 + (documentCount - matchingDocuments + 0.5) / (matchingDocuments + 0.5),
    );
    const normalizedFrequency =
      (frequency * (k1 + 1)) /
      (frequency + k1 * (1 - b + b * (length / Math.max(averageLength, 1))));
    score += inverseDocumentFrequency * normalizedFrequency;
  }

  const lowerPath = chunk.path.toLocaleLowerCase();
  for (const term of queryTerms) {
    if (lowerPath.includes(term)) {
      score += 1.5;
    }
  }

  return { chunk, score, matchedTerms };
}

function assembleContext(
  originalQuery: string,
  expandedTerms: string[],
  ranked: Array<{ chunk: CodeChunk; score: number; matchedTerms: string[] }>,
  maxContextChars: number,
): RetrievalResult {
  const snippets: RetrievalSnippet[] = [];
  const renderedParts: string[] = [];
  let usedChars = 0;

  for (const item of ranked) {
    const header = `### ${item.chunk.path}:${item.chunk.startLine}-${item.chunk.endLine}\n`;
    const separatorLength = renderedParts.length === 0 ? 0 : 2;
    const remaining = maxContextChars - usedChars - separatorLength - header.length;
    if (remaining <= 40) {
      break;
    }

    const truncated = item.chunk.content.length > remaining;
    const content = truncated
      ? `${item.chunk.content.slice(0, Math.max(remaining - 16, 1))}\n…[truncated]`
      : item.chunk.content;
    const rendered = `${header}${content}`;
    renderedParts.push(rendered);
    usedChars += separatorLength + rendered.length;
    snippets.push({
      path: item.chunk.path,
      startLine: item.chunk.startLine,
      endLine: item.chunk.endLine,
      score: Number(item.score.toFixed(4)),
      content,
      matchedTerms: item.matchedTerms,
      truncated,
    });
    if (truncated) {
      break;
    }
  }

  const renderedContext = renderedParts.join("\n\n");
  return {
    originalQuery,
    expandedTerms,
    snippets,
    renderedContext,
    usedChars: renderedContext.length,
    maxContextChars,
  };
}

function calculateDocumentFrequency(chunks: CodeChunk[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const chunk of chunks) {
    for (const term of chunk.termFrequency.keys()) {
      result.set(term, (result.get(term) ?? 0) + 1);
    }
  }
  return result;
}

function frequencyMap(terms: string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const term of terms) {
    result.set(term, (result.get(term) ?? 0) + 1);
  }
  return result;
}

function termCount(frequencies: Map<string, number>): number {
  return [...frequencies.values()].reduce((sum, count) => sum + count, 0);
}

function normalizePrefixes(prefixes: string[] | undefined): string[] {
  return (prefixes ?? [])
    .map((prefix) => toPosixPath(prefix).replace(/^\.\/|\/$/g, ""))
    .filter(Boolean);
}

function isBelowPrefix(relativePath: string, prefix: string): boolean {
  return relativePath === prefix || relativePath.startsWith(`${prefix}/`);
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(Math.floor(value), minimum), maximum);
}
