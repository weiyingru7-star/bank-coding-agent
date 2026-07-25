# Bank Coding Agent VS Code Extension

## 本地运行

在项目根目录安装并构建：

```text
pnpm install
pnpm --filter bank-coding-agent-vscode build
```

启动 Agent Server：

```text
pnpm --filter @bank-agent/agent-server start
```

然后用 VS Code 打开 `bank-coding-agent` 项目，按 F5 启动 Extension Development Host。

在新窗口中打开：

```text
fixtures/bank-transfer-demo
```

通过命令面板执行：

```text
Bank Agent: 创建编码任务
```

输入：

```text
给转账服务增加每日累计限额校验并补充测试
```

默认身份是 `DEVELOPER`，可以查看 Diff 或取消，但不能审批。为了演示 Reviewer 审批，可在设置中将：

```text
bankAgent.demoUserId = reviewer-001
bankAgent.demoUserRole = REVIEWER
```

真实生产环境不能让客户端配置身份和角色，必须由服务端验证 SSO Token 后生成身份上下文。

## 当前能力

- 采集工作区、当前文件和最多 5000 字符的选区。
- 创建任务并保存最近任务 ID。
- 读取 SSE 事件并输出 Agent 执行过程。
- 使用 VS Code Diff 编辑器预览补丁。
- Reviewer 审批、任务所有者取消。
- 展示测试命令、退出码和任务最终状态。

## 当前限制

- Git 分支和 commit 暂用 `working-tree`，尚未接入 VS Code Git API。
- SSE 当前为服务端事件重放，尚未保持实时长连接。
- 身份与角色使用本地演示配置。
- Server 任务和审批保存在内存，重启后会丢失。

