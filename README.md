# Bank Coding Agent

一个面向银行研发场景的最小可演示 Coding Agent，用于学习和面试讲解。

## 项目目标

开发者在 VS Code 中输入自然语言需求，例如：

> 给转账服务增加每日累计限额校验，超过限额返回统一错误码，记录审计日志，并补充单元测试。

系统完成：

1. 收集当前文件、选区、Git 分支和最近修改。
2. 在用户有权访问的代码范围内搜索相关实现。
3. 生成可验证的任务计划。
4. 通过受控工具读取文件、生成补丁和运行测试。
5. 对交易、认证、配置等高风险修改要求人工审批。
6. 展示 diff，校验文件版本后安全应用。
7. 记录模型、检索、工具、策略、审批和测试审计事件。

## 为什么先使用 Mock 模型

第一阶段不连接真实大模型，而是让 Mock 模型针对固定的银行转账示例产生确定性计划和工具调用。这样可以先理解并验证 Agent Runtime，而不会把“模型是否聪明”与“平台是否安全可靠”混在一起。

模型接入作为独立适配器，当前已经提供 Responses API 风格的真实模型适配器，可以指向 OpenAI API，也可以指向实现同类协议的企业模型网关。默认测试使用录制响应，不需要 API Key，也不会把样例代码发送到外部。

## 技术路线

- TypeScript：VS Code 插件、Agent Server 与共享模块。
- Node.js：Agent API、Runtime、工具执行和任务状态机。
- React：后续实现策略、审批和审计管理台。
- SQLite：学习阶段保存任务、步骤、审批和审计事件。
- Mock Model：第一阶段提供可复现的工具调用。
- Vitest：单元测试与 Agent 端到端测试。

生产化时可以将 SQLite 替换为 PostgreSQL，将本地任务调度替换为 Redis/消息队列，并把工具执行迁移到容器沙箱。

## 模块规划

```text
bank-coding-agent/
├── apps/
│   ├── vscode-extension/       IDE 入口、上下文采集、diff 与审批交互
│   ├── agent-server/           HTTP/SSE API、任务状态机和任务调度
│   └── admin-console/          策略、模型、审批和审计管理台
├── packages/
│   ├── agent-runtime/          Agent Loop、步骤状态、取消与恢复
│   ├── model-gateway/          模型适配、合规路由、限流、重试、熔断和输入脱敏
│   ├── prompt-management/      Prompt版本、变量、灰度、边界封装和发布检查
│   ├── task-scheduler/         幂等队列、Worker租约、心跳、恢复和死信
│   ├── retrieval/              授权过滤、关键词排序、查询扩展和上下文预算
│   ├── policy-engine/          RBAC/ABAC、风险分级和审批决定
│   ├── toolkit/                search/read/apply_patch/run_tests 工具
│   ├── audit/                  结构化、脱敏、可追踪的审计事件
│   └── contracts/              API、任务、工具和策略的共享类型
├── fixtures/
│   └── bank-transfer-demo/     可安全修改的模拟银行转账项目
└── docs/
    └── architecture.md         架构、边界和关键设计决策
```

## 第一条端到端业务链路

```text
用户提交需求
→ 创建任务并生成幂等键
→ 验证用户和工作区权限
→ 采集 IDE 上下文
→ 检索转账、限额、错误码和审计实现
→ Mock Planner 生成计划
→ Runtime 先调用 retrieve_context 获取排序后的授权代码片段
→ Runtime 再调用 search/read 获取精确位置和完整文件
→ Mock Coder 生成结构化补丁
→ Policy 判定为交易核心逻辑，需要审批
→ 用户查看 diff 并批准
→ Runtime 校验文件版本并应用补丁
→ 在隔离范围内运行测试
→ 输出结果并记录审计事件
```

## 安全边界

- 模型只能提出工具调用意图，不能直接操作文件。
- Runtime 只执行注册过且通过 Schema 校验的工具。
- 所有路径必须位于授权工作区，禁止 `../` 路径穿越。
- 检索前过滤仓库权限，工具执行前再次校验动作权限。
- 修改交易、认证、权限、数据库迁移和生产配置必须审批。
- 密钥文件、工作区外文件、主分支推送和部署默认禁止。
- 文件修改使用版本/哈希前置条件，避免覆盖用户新修改。
- 构建和测试最终应迁移到受限沙箱中执行。

## 学习阶段

1. 架构与共享协议。
2. 模拟银行转账项目。
3. Agent Runtime 与 Mock Model。
4. 搜索、读取、补丁和测试工具。
5. Policy、审批与审计。
6. VS Code 插件。
7. 代码 RAG 与真实模型适配。
8. React 管理台、评测与面试演示。

## 第十五课快捷验证

```bash
pnpm test:model
pnpm test:retrieval
pnpm demo:retrieval
pnpm demo:model-gateway
pnpm demo:prompt
pnpm demo:scheduler
```

真实模型适配器采用“模型建议工具调用，Runtime 校验并执行”的方式。它只向模型暴露
`retrieve_context`、`search_code`、`read_file` 和 `propose_patch`；`apply_patch` 与 `run_tests`
不会暴露给规划模型，仍由审批后的 Runtime 确定性控制。
