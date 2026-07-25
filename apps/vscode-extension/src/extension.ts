import * as vscode from "vscode";
import { randomUUID } from "node:crypto";

import type {
  CreateTaskRequest,
  PatchProposal,
  RuntimeEvent,
} from "../../../packages/contracts/src/index.ts";
import {
  AgentApiClient,
  type CreateTaskApiResult,
  type TaskApiResult,
} from "./agent-api-client.ts";

const lastTaskIdKey = "bankAgent.lastTaskId";
const lastProposalKey = "bankAgent.lastProposal";
const proposalScheme = "bank-agent-proposal";

class ProposalDocumentProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changeEmitter.event;

  set(uri: vscode.Uri, content: string): void {
    this.contents.set(uri.toString(), content);
    this.changeEmitter.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Bank Coding Agent");
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  const proposalProvider = new ProposalDocumentProvider();
  status.text = "$(shield) Bank Agent";
  status.tooltip = "创建安全的银行 Coding Agent 任务";
  status.command = "bankAgent.startTask";
  status.show();

  context.subscriptions.push(
    output,
    status,
    proposalProvider,
    vscode.workspace.registerTextDocumentContentProvider(proposalScheme, proposalProvider),
    vscode.commands.registerCommand("bankAgent.startTask", async () => {
      await startTask(context, output, status, proposalProvider);
    }),
    vscode.commands.registerCommand("bankAgent.showProposal", async () => {
      await showLastProposal(context, proposalProvider);
    }),
    vscode.commands.registerCommand("bankAgent.approveTask", async () => {
      await approveLastTask(context, output, status);
    }),
    vscode.commands.registerCommand("bankAgent.cancelTask", async () => {
      await cancelLastTask(context, output, status);
    }),
  );
}

export function deactivate(): void {}

async function startTask(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  status: vscode.StatusBarItem,
  proposalProvider: ProposalDocumentProvider,
): Promise<void> {
  const workspaceFolder = getWorkspaceFolder();
  if (!workspaceFolder) {
    void vscode.window.showErrorMessage("请先打开一个工作区。");
    return;
  }
  const command = await vscode.window.showInputBox({
    title: "创建 Bank Coding Agent 任务",
    prompt: "请用自然语言描述要修改的内容",
    placeHolder: "例如：给转账服务增加每日累计限额校验并补充测试",
    ignoreFocusOut: true,
  });
  if (!command?.trim()) {
    return;
  }

  const editor = vscode.window.activeTextEditor;
  const selection = editor && !editor.selection.isEmpty
    ? editor.document.getText(editor.selection).slice(0, 5_000)
    : undefined;
  const currentFile = editor
    ? vscode.workspace.asRelativePath(editor.document.uri, false)
    : undefined;
  const config = vscode.workspace.getConfiguration("bankAgent");
  const request: CreateTaskRequest = {
    idempotencyKey: `${vscode.env.sessionId}-${randomUUID()}`,
    command: command.trim(),
    workspace: {
      workspaceId: config.get<string>("workspaceId", "bank-transfer-demo"),
      rootPath: workspaceFolder.uri.fsPath,
      repository: workspaceFolder.name,
      branch: "working-tree",
      baseRevision: "working-tree",
      ...(currentFile ? { currentFile } : {}),
      ...(selection ? { selectedText: selection } : {}),
    },
  };

  output.show(true);
  output.appendLine(`\n[创建任务] ${request.command}`);
  status.text = "$(loading~spin) Bank Agent: 正在分析";

  try {
    const result = await createClient().createTask(request);
    await saveTask(context, result);
    output.appendLine(`taskId=${result.task.taskId}`);
    output.appendLine(`status=${result.task.status}, risk=${result.task.riskLevel}`);
    const events = await createClient().getEvents(result.task.taskId);
    appendEvents(output, events);
    await reactToTaskState(context, result, status, proposalProvider);
  } catch (error) {
    status.text = "$(error) Bank Agent: 失败";
    void vscode.window.showErrorMessage(formatError(error));
  }
}

async function reactToTaskState(
  context: vscode.ExtensionContext,
  result: CreateTaskApiResult | TaskApiResult,
  status: vscode.StatusBarItem,
  proposalProvider: ProposalDocumentProvider,
): Promise<void> {
  if (result.task.status === "WAITING_APPROVAL") {
    status.text = "$(warning) Bank Agent: 等待审批";
    const role = vscode.workspace
      .getConfiguration("bankAgent")
      .get<string>("demoUserRole", "DEVELOPER");
    const choices = role === "REVIEWER"
      ? ["查看 Diff", "批准", "取消"]
      : ["查看 Diff", "取消"];
    const action = await vscode.window.showWarningMessage(
      `高风险修改：${result.proposal?.summary ?? "需要 Reviewer 审批"}`,
      ...choices,
    );
    if (action === "查看 Diff") {
      await showLastProposal(context, proposalProvider);
    } else if (action === "批准") {
      await vscode.commands.executeCommand("bankAgent.approveTask");
    } else if (action === "取消") {
      await vscode.commands.executeCommand("bankAgent.cancelTask");
    }
  } else if (result.task.status === "SUCCEEDED") {
    status.text = "$(pass) Bank Agent: 已完成";
    void vscode.window.showInformationMessage("Bank Coding Agent 任务已完成并通过测试。");
  } else if (result.task.status === "CANCELLED") {
    status.text = "$(circle-slash) Bank Agent: 已取消";
  } else {
    status.text = `$(info) Bank Agent: ${result.task.status}`;
  }
}

async function approveLastTask(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  status: vscode.StatusBarItem,
): Promise<void> {
  const taskId = context.workspaceState.get<string>(lastTaskIdKey);
  if (!taskId) {
    void vscode.window.showErrorMessage("当前工作区没有待审批任务。");
    return;
  }
  const role = vscode.workspace
    .getConfiguration("bankAgent")
    .get<string>("demoUserRole", "DEVELOPER");
  if (role !== "REVIEWER") {
    void vscode.window.showErrorMessage("当前用户不是 Reviewer，不能审批高风险补丁。");
    return;
  }
  status.text = "$(loading~spin) Bank Agent: 正在应用和测试";
  try {
    const result = await createClient().approveTask(taskId);
    output.appendLine("\n[审批完成]");
    appendEvents(output, result.events ?? []);
    for (const testResult of result.testResults ?? []) {
      output.appendLine(
        `${testResult.command}: exitCode=${testResult.exitCode}, durationMs=${testResult.durationMs}`,
      );
    }
    await reactToTaskState(context, result, status, new ProposalDocumentProvider());
  } catch (error) {
    status.text = "$(error) Bank Agent: 审批失败";
    void vscode.window.showErrorMessage(formatError(error));
  }
}

async function cancelLastTask(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  status: vscode.StatusBarItem,
): Promise<void> {
  const taskId = context.workspaceState.get<string>(lastTaskIdKey);
  if (!taskId) {
    void vscode.window.showErrorMessage("当前工作区没有可取消任务。");
    return;
  }
  try {
    const result = await createClient().cancelTask(taskId);
    output.appendLine(`\n[任务取消] ${taskId}`);
    status.text = "$(circle-slash) Bank Agent: 已取消";
    await context.workspaceState.update(lastProposalKey, undefined);
    void vscode.window.showInformationMessage(`任务状态：${result.task.status}`);
  } catch (error) {
    void vscode.window.showErrorMessage(formatError(error));
  }
}

async function showLastProposal(
  context: vscode.ExtensionContext,
  provider: ProposalDocumentProvider,
): Promise<void> {
  const proposal = context.workspaceState.get<PatchProposal>(lastProposalKey);
  const workspaceFolder = getWorkspaceFolder();
  if (!proposal || !workspaceFolder) {
    void vscode.window.showErrorMessage("当前工作区没有可预览的补丁。");
    return;
  }
  const edit = proposal.edits[0];
  if (!edit) {
    return;
  }
  const originalUri = vscode.Uri.joinPath(workspaceFolder.uri, edit.path);
  const originalBytes = await vscode.workspace.fs.readFile(originalUri);
  let modified = new TextDecoder().decode(originalBytes);
  for (const replacement of edit.replacements) {
    const count = modified.split(replacement.oldText).length - 1;
    if (count !== 1) {
      void vscode.window.showErrorMessage(
        `无法安全预览 ${edit.path}：预期代码出现 ${count} 次。`,
      );
      return;
    }
    modified = modified.replace(replacement.oldText, replacement.newText);
  }
  const proposalUri = vscode.Uri.from({
    scheme: proposalScheme,
    path: `/${edit.path}`,
    query: `task=${context.workspaceState.get<string>(lastTaskIdKey) ?? ""}`,
  });
  provider.set(proposalUri, modified);
  await vscode.commands.executeCommand(
    "vscode.diff",
    originalUri,
    proposalUri,
    `Bank Agent Proposal: ${edit.path}`,
    { preview: true },
  );
}

function createClient(): AgentApiClient {
  const config = vscode.workspace.getConfiguration("bankAgent");
  return new AgentApiClient({
    baseUrl: config.get<string>("serverUrl", "http://127.0.0.1:8787"),
    userId: config.get<string>("demoUserId", "developer-001"),
    role: config.get<string>("demoUserRole", "DEVELOPER"),
  });
}

async function saveTask(
  context: vscode.ExtensionContext,
  result: CreateTaskApiResult,
): Promise<void> {
  await context.workspaceState.update(lastTaskIdKey, result.task.taskId);
  await context.workspaceState.update(lastProposalKey, result.proposal);
}

function getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  return activeUri
    ? vscode.workspace.getWorkspaceFolder(activeUri) ?? vscode.workspace.workspaceFolders?.[0]
    : vscode.workspace.workspaceFolders?.[0];
}

function appendEvents(output: vscode.OutputChannel, events: RuntimeEvent[]): void {
  for (const event of events) {
    output.appendLine(
      `${String(event.sequence).padStart(2, "0")} ${event.type.padEnd(20)} ${event.message}`,
    );
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}
