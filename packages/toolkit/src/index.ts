import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  AppliedPatchResult,
  PatchProposal,
  ReadFileArguments,
  ReadFileResult,
  RetrieveContextArguments,
  SearchCodeArguments,
  SearchCodeMatch,
  TestCommandResult,
} from "../../contracts/src/index.ts";
import {
  RepositoryRetriever,
  type RetrievalPolicy,
  type RetrievalResult,
} from "../../retrieval/src/index.ts";

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

export class WorkspaceBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceBoundaryError";
  }
}

export class WorkspaceToolkit {
  readonly workspaceRoot: string;
  private readonly rollbackSnapshots = new Map<string, Map<string, string>>();
  private readonly retriever: RepositoryRetriever;

  constructor(workspaceRoot: string, retrievalPolicy: RetrievalPolicy = {}) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.retriever = new RepositoryRetriever(this.workspaceRoot, retrievalPolicy);
  }

  async retrieveContext(arguments_: RetrieveContextArguments): Promise<RetrievalResult> {
    return this.retriever.retrieve(arguments_.query, {
      maxResults: arguments_.maxResults,
      maxContextChars: arguments_.maxContextChars,
    });
  }

  async searchCode(arguments_: SearchCodeArguments): Promise<SearchCodeMatch[]> {
    const query = arguments_.query.trim();
    if (!query) {
      throw new Error("search_code query cannot be empty");
    }

    const maxResults = Math.min(Math.max(arguments_.maxResults ?? 20, 1), 100);
    const files = await this.collectFiles(this.workspaceRoot);
    const matches: SearchCodeMatch[] = [];
    const normalizedQuery = query.toLocaleLowerCase();

    for (const absolutePath of files) {
      const content = await readFile(absolutePath, "utf8");
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        if (line.toLocaleLowerCase().includes(normalizedQuery)) {
          matches.push({
            path: this.toRelativePath(absolutePath),
            line: index + 1,
            preview: line.trim().slice(0, 240),
          });
          if (matches.length >= maxResults) {
            return matches;
          }
        }
      }
    }

    return matches;
  }

  async readWorkspaceFile(arguments_: ReadFileArguments): Promise<ReadFileResult> {
    const absolutePath = this.resolveWorkspacePath(arguments_.path);
    const content = await readFile(absolutePath, "utf8");
    const maxChars = Math.min(Math.max(arguments_.maxChars ?? 20_000, 1), 100_000);
    const truncated = content.length > maxChars;
    return {
      path: this.toRelativePath(absolutePath),
      content: truncated ? content.slice(0, maxChars) : content,
      sha256: createHash("sha256").update(content).digest("hex"),
      truncated,
    };
  }

  validateProposal(proposal: PatchProposal): PatchProposal {
    if (!proposal.summary.trim()) {
      throw new Error("Patch proposal summary cannot be empty");
    }
    if (proposal.edits.length === 0) {
      throw new Error("Patch proposal must contain at least one file edit");
    }

    for (const edit of proposal.edits) {
      this.resolveWorkspacePath(edit.path);
      if (!edit.expectedSha256) {
        throw new Error(`Missing expectedSha256 for ${edit.path}`);
      }
      if (edit.replacements.length === 0) {
        throw new Error(`No replacements provided for ${edit.path}`);
      }
      for (const replacement of edit.replacements) {
        if (!replacement.oldText) {
          throw new Error(`Replacement oldText cannot be empty for ${edit.path}`);
        }
      }
    }

    return structuredClone(proposal);
  }

  async applyProposal(proposalInput: PatchProposal): Promise<AppliedPatchResult> {
    const proposal = this.validateProposal(proposalInput);
    const originals = new Map<string, string>();
    const nextContents = new Map<string, string>();
    const editedFiles: AppliedPatchResult["editedFiles"] = [];

    for (const edit of proposal.edits) {
      const absolutePath = this.resolveWorkspacePath(edit.path);
      const original = await readFile(absolutePath, "utf8");
      const beforeSha256 = this.sha256(original);
      if (beforeSha256 !== edit.expectedSha256) {
        throw new Error(
          `File version conflict for ${edit.path}: expected ${edit.expectedSha256}, actual ${beforeSha256}`,
        );
      }

      let nextContent = original;
      for (const replacement of edit.replacements) {
        const occurrenceCount = nextContent.split(replacement.oldText).length - 1;
        if (occurrenceCount !== 1) {
          throw new Error(
            `Patch dry-run failed for ${edit.path}: expected oldText exactly once, found ${occurrenceCount}`,
          );
        }
        nextContent = nextContent.replace(replacement.oldText, replacement.newText);
      }

      originals.set(absolutePath, original);
      nextContents.set(absolutePath, nextContent);
      editedFiles.push({
        path: edit.path,
        beforeSha256,
        afterSha256: this.sha256(nextContent),
      });
    }

    const writtenFiles: string[] = [];
    try {
      for (const [absolutePath, content] of nextContents) {
        await writeFile(absolutePath, content, "utf8");
        writtenFiles.push(absolutePath);
      }
    } catch (error) {
      for (const absolutePath of writtenFiles) {
        const original = originals.get(absolutePath);
        if (original !== undefined) {
          await writeFile(absolutePath, original, "utf8");
        }
      }
      throw error;
    }

    const rollbackId = randomUUID();
    this.rollbackSnapshots.set(rollbackId, originals);
    return { rollbackId, editedFiles };
  }

  async rollbackPatch(rollbackId: string): Promise<void> {
    const originals = this.rollbackSnapshots.get(rollbackId);
    if (!originals) {
      throw new Error(`Rollback snapshot not found: ${rollbackId}`);
    }
    for (const [absolutePath, original] of originals) {
      await writeFile(absolutePath, original, "utf8");
    }
    this.rollbackSnapshots.delete(rollbackId);
  }

  async runTestCommands(commands: string[], timeoutMs = 10_000): Promise<TestCommandResult[]> {
    const allowedCommands = new Map<string, { executable: string; args: string[] }>([
      ["pnpm test", { executable: "pnpm", args: ["test"] }],
      ["pnpm test:requirement", { executable: "pnpm", args: ["test:requirement"] }],
    ]);
    const results: TestCommandResult[] = [];

    for (const command of commands) {
      const allowed = allowedCommands.get(command);
      if (!allowed) {
        throw new Error(`Test command is not allowlisted: ${command}`);
      }
      const result = await this.spawnCommand(command, allowed.executable, allowed.args, timeoutMs);
      results.push(result);
      if (result.exitCode !== 0 || result.timedOut) {
        break;
      }
    }
    return results;
  }

  private resolveWorkspacePath(relativePath: string): string {
    if (!relativePath || path.isAbsolute(relativePath)) {
      throw new WorkspaceBoundaryError("Tool paths must be relative to the authorized workspace");
    }

    const resolved = path.resolve(this.workspaceRoot, relativePath);
    const relative = path.relative(this.workspaceRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new WorkspaceBoundaryError(`Path escapes authorized workspace: ${relativePath}`);
    }
    return resolved;
  }

  private toRelativePath(absolutePath: string): string {
    return path.relative(this.workspaceRoot, absolutePath).split(path.sep).join("/");
  }

  private sha256(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }

  private async spawnCommand(
    command: string,
    executable: string,
    args: string[],
    timeoutMs: number,
  ): Promise<TestCommandResult> {
    const startedAt = performance.now();
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: this.workspaceRoot,
        shell: false,
        env: {
          PATH: process.env.PATH ?? "",
          LANG: process.env.LANG ?? "C.UTF-8",
        },
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      child.stdout.on("data", (chunk) => {
        stdout = (stdout + String(chunk)).slice(-20_000);
      });
      child.stderr.on("data", (chunk) => {
        stderr = (stderr + String(chunk)).slice(-20_000);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        resolve({
          command,
          exitCode,
          timedOut,
          durationMs: Math.round(performance.now() - startedAt),
          stdout,
          stderr,
        });
      });
    });
  }

  private async collectFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isDirectory() && excludedDirectories.has(entry.name)) {
        continue;
      }

      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await this.collectFiles(absolutePath)));
      } else if (entry.isFile() && searchableExtensions.has(path.extname(entry.name))) {
        files.push(absolutePath);
      }
    }

    return files;
  }
}
