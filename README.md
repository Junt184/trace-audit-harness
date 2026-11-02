# Trace · Agent 代码审计 Harness

**基于 [Pi SDK](https://github.com/earendil-works/pi) 构建的本地代码审计 Harness。** 让模型在真实源码目录中阅读代码、追踪调用、编写并运行实验、查询修复资料，并在可恢复的会话里持续完成审计。

**简体中文（主文档）** · [English](README.en.md)

Trace 复用 Pi 的模型交互、工具执行、文件会话和上下文压缩，在此基础上实现审计专用工具、工作空间、证据记录及 Web 工作台。模型自主选择分析与验证路径；Harness 提供信息、执行动作、保存过程和延续任务。

当前版本为 `0.1.0`，使用 **Pi SDK 1.4.0**，面向本地单用户使用。界面中的模型输出、工具调用、发现和运行状态均来自实际执行。

## 能做什么

- **阅读与追踪代码**：语法树符号轮廓、按函数/方法读取、候选引用、语言服务器语义引用，以及可查询、可视化的静态调用图。
- **用自然语言找代码**：真实本地 embedding 模型检索代码和文档，支持中文查询、按范围索引和增量更新。
- **验证想法**：保留普通 shell 与文件工具，提供精确 argv 执行、超时、取消和完整日志；模型可以自行编写 probe 和定向测试。
- **核对修复证据**：读取本地 Git 历史、GitHub/OSV 资料及补丁，核验来源关系、检查本地适用条件，在独立 Git 快照中运行补丁前后对照实验。
- **连续工作并保留成果**：项目工作空间、实时执行轨迹、发现、笔记、报告、停止/继续、重启恢复、上下文压缩和 Markdown 导出。

## 快速开始

需要 **Node.js 22.22.2+**、npm，以及要审计的本地源码目录。本机验收使用 Node.js `24.18.0`。

还需要安装 `rg`（ripgrep）；Git 历史和补丁工具需要 `git`，在线资料工具需要 `curl`。目标项目的 Python、PHP、Java、Go、依赖及构建工具按具体实验准备。Tree-sitter 使用预编译 WASM。

```bash
git clone https://github.com/Junt184/trace-audit-harness.git
cd trace-audit-harness
npm ci
npm run dev
```

打开 **http://127.0.0.1:4317**，在右上角「模型配置」填写模型服务及 API Key。点击「测试真实连接」会产生一次真实模型请求。

也可以通过环境文件配置：

```bash
cp .env.example .env
# 编辑 .env，填写自己的模型配置和凭据
npm run dev
```

构建后运行：

```bash
npm run build
npm start
```

开发命令没有自动重启；修改后端 TypeScript 后需重启服务，修改前端后刷新页面。终端按 Ctrl+C 停止服务。

## 配置模型与网络

默认配置如下；`deepseek-flash` 是既有真实联调使用的模型 ID，使用时请以自己的供应商实际可用模型为准。

```dotenv
MODEL_PROVIDER=deepseek
MODEL_BASE_URL=https://api.deepseek.com/v1
MODEL_ID=deepseek-flash
MODEL_API=openai-completions
DEEPSEEK_API_KEY=
GITHUB_PROXY=http://127.0.0.1:7890
```

支持配置 Chat Completions（`openai-completions`）、Responses（`openai-responses`）和 Anthropic Messages（`anthropic-messages`）。兼容服务需要支持工具调用；历史端到端验收主要覆盖 DeepSeek Chat Completions，其他供应商仍需验证。

工作台保存的模型字段优先于 `.env`。凭据优先级为：工作台保存的 key → `MODEL_API_KEY` → 对应供应商环境变量 → 可用的本机 DSH DeepSeek 凭据。DSH 回退只读取 `~/.dsh/.credentials.yaml`，可用 `USE_DSH_CREDENTIALS=false` 关闭。需要恢复环境文件管理时，可在停止服务后备份并移走 `.audit-harness/config.json`。

上下文窗口和最大输出 token 可在模型配置界面填写；默认分别为 `131072` 和 `8192`。填写容量并不证明供应商实际支持该窗口。

| 变量 | 默认值或用途 |
| --- | --- |
| `PORT` | `4317`，服务只监听 `127.0.0.1` |
| `DEFAULT_REPO` | 默认项目目录；不填时为本工作台目录 |
| `AUDIT_DATA_DIR` | 默认 `.audit-harness`，保存配置、会话、产物、索引和模型缓存 |
| `MODEL_API_KEY` | 自定义兼容服务的通用 key；官方端点也支持对应的 `DEEPSEEK_API_KEY`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY` |
| `GITHUB_PROXY` | GitHub 请求代理，默认 `http://127.0.0.1:7890` |
| `OSV_PROXY` | 默认共用 GitHub 代理；显式设为空字符串可直连 OSV |
| `GITHUB_TOKEN` | 可选，供服务端 GitHub 来源请求使用，提高 API 额度 |
| `USE_DSH_CREDENTIALS` | 默认启用；设为 `false` 关闭 DSH 凭据回退 |
| `GOPLS_PATH` | 可选，指定 `gopls` 路径 |
| `AUDIT_LSP_SERVERS` | 可选，按语言覆盖启动命令数组；Java 自定义命令可用 `{workspace}` 占位临时目录 |
| `JDTLS_HOME` / `JAVA_HOME` | 可选，指定 JDT LS 发行目录及启动服务器的 JDK 21+ |
| `AUDIT_EMBED_MODEL` | 默认 `Xenova/multilingual-e5-small` |
| `AUDIT_EMBED_REVISION` | 默认模型固定到源码中的 revision；自定义模型默认 `main` |
| `AUDIT_EMBED_PROXY` | 默认共用 GitHub 代理；显式设为空字符串可直接下载模型 |

**网络配置请按本机环境调整。** GitHub 工具当前默认使用本地代理，未运行该代理会导致在线查询失败；把 `GITHUB_PROXY` 留空仍会回到默认地址。OSV 和 embedding 下载可分别设置空代理直连。模型请求默认直接访问所配置的供应商端点。

通过界面保存的模型 key 写入本机配置文件，权限为 `0600`；配置 API 不返回 key，运行元数据不保存 key。`.env`、运行记录、模型缓存和索引均被 Git 忽略。

## 完成一次审计

1. 在左上角选择或创建项目工作空间，指定本机源码目录。同一真实目录会复用已有工作空间。
2. 填写范围明确的目标，也可以使用「符号追踪」「修复对比」「语义引用」「在线修复」「项目调用图」「向量检索」快捷提示。
3. 点击「开始审计」，在执行轨迹中查看模型输出、工具参数与实际结果；展开卡片可打开完整日志、补丁、来源或调用图。
4. 在「发现」「报告」「笔记」查看模型保存的成果。「报告」是最近一轮非空最终回答，先前回答仍保留在轨迹中。
5. 运行时可点击「停止执行」。任务空闲后输入补充指令并「继续审计」，恢复同一份 Pi 会话；也可手动压缩上下文后继续。
6. 使用「导出报告」下载 Markdown。刷新或重启服务会保留历史；异常中断的任务标记为「执行中断」，可手动续接。

建议从一个模块开始：

> 只读审计上传处理模块，追踪文件名与保存路径的关系。读取相关代码和测试，必要时在审计产物目录编写最小 probe。记录有依据的候选、前置条件和验证边界，并在笔记保存反证与下一步。

工作空间按代码目录组织记录，切换项目或页面不会停止后台任务。模型保留 shell、编辑和写入能力；工作空间不提供进程或文件系统隔离。

## 接入的工具

Pi 通用工具：`read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`。另有 **19 个审计专用工具**，共 26 个工具入口。

| 工具 | 用途 |
| --- | --- |
| `project_overview` | 顶层目录、Git 版本与工作区状态 |
| `code_outline` | Tree-sitter 符号、限定名、真实行范围；支持分页和 Git revision |
| `read_symbol` | 按函数、类或方法读源码，返回行号及 hash，支持重载消歧和历史版本 |
| `find_references` | 过滤注释/字符串的同名候选引用与调用上下文 |
| `semantic_references` | 通过真实语言服务器按光标解析定义与引用 |
| `build_call_graph` | 对选定范围构建静态调用图，保存节点、调用边、覆盖情况和未解析项 |
| `query_call_graph` | 查询调用图上下游及传递关系，检查已有源码是否变化 |
| `semantic_search` | 本地神经网络向量检索，返回代码片段、范围、hash 和相似度 |
| `git_refs` | 本地分支、远端跟踪分支和 tag |
| `git_history` | 按提交说明、变更文本、路径检索本地提交 |
| `git_patch` | 提交补丁或版本差异，分页返回并保存完整捕获内容 |
| `search_fix_sources` | GitHub 通告、提交/issue/PR 候选和 OSV 包版本查询 |
| `read_fix_source` | 读取 GHSA、commit、PR、issue、Gist、OSV，保存原始资料及可用补丁 |
| `verify_fix_source` | 分别核对来源身份、仓库、提交及显式引用关系 |
| `check_fix_applicability` | 补丁正反向只读匹配检查、依赖/配置取证和模型编写的运行条件检查 |
| `compare_patch` | 在独立 Git 快照上运行相同脚本，记录补丁前后输出及断言结果 |
| `run_command` | 精确 argv 执行、完整日志落盘、超时与进程组取消 |
| `record_finding` | 保存或更新发现、状态、严重性、证据、前置条件和建议 |
| `audit_notes` | 读写持久笔记、已排除思路与下一步 |

### 语言与代码分析

| 语言 | 语法树符号读取 | 语义定义/引用 |
| --- | --- | --- |
| JavaScript / TypeScript / TSX | 支持 | 内置 typescript-language-server；工程回归通过 |
| Python | 支持 | 内置 Pyright；工程回归通过 |
| Go | 支持 | 需要本机 `gopls` 及项目工具链/依赖；本机回归通过 |
| PHP / PHTML | 支持 | 内置 Intelephense；PHP 跨文件引用及调用边回归通过 |
| Java | 支持 | 固定版本 JDT LS；Maven 跨文件引用、构造器、重载及调用链本机验收通过 |

`semantic_references` 的行、列从 1 开始，列使用 UTF-16 编码，光标需指向标识符。可用 `projectRoot` 覆盖自动发现的根目录。语义查询每次启动独立语言服务器，完成或取消时退出；大项目加载可能较慢，默认超时 90 秒。

Java 首次使用先安装 JDK 21+，再运行：

```bash
npm run setup:java
# 需要代理时：HTTPS_PROXY=http://127.0.0.1:7890 npm run setup:java
```

安装脚本下载 Eclipse 官方 JDT LS `1.63.0`，校验固定 SHA-256，保存到忽略的 `.audit-harness/servers/`。已有发行包可通过 `JDTLS_HOME` 指定；否则回退到 PATH 中的 `jdtls`。运行 JDK 通过 `JAVA_HOME` 选择，项目目标 JDK/依赖仍按自身构建配置准备。Java 查询等待 `language/status: Started` 后开始，默认启动器为每次查询创建独立配置和工作目录，退出后清理，并把新生成的 Eclipse 元数据放在临时工作目录。自定义 `AUDIT_LSP_SERVERS.java` 命令需自行提供相应启动选项，`{workspace}` 会替换成该次查询的临时目录。当前 Java 实测为 Maven 样例，未据此宣称所有 Gradle、框架和依赖组合均通过。

调用图的使用闭环：

1. 在「项目调用图」快捷提示中指定范围，模型调用 `build_call_graph(scope=".",timeoutSeconds=180)`。按语言和项目根目录分组，用语法树提取调用点，再用语言服务器定义绑定建立边。
2. 工具卡片给出完整 JSON 和 Web 查看器。页面可搜索符号、查看直接/传递上下游、点击节点查看签名和准确调用位置，并下载原图。
3. 模型调用 `query_call_graph`，指定 `artifact`、`symbol`、`path`、`direction` 和 `transitive`，支持循环和分页。查询重新枚举原范围，返回修改/删除的 `staleFiles`、新增的 `addedFiles`，以及 `freshness`；页面自动检查，也可点击「检查源码变化」。变化后重新构图。
4. 服务器失败或达到截止时间会保留部分图，每个已提取调用点都有已解析或未解析记录；用户取消会终止当前服务器并结束工具，不保存本次未完成图。

PHP、Java、Python、Go 已通过同一次真实模型调用的构图与四次调用链查询：9 个源码文件、13 个调用点、12 条绑定边、1 个显式未解析回调。该验收使用仓库自带的受控样例，TypeScript 另有真实服务器回归。默认枚举遵循 rg ignore 规则，并在任意深度排除依赖/构建目录，包括 `node_modules/vendor/dist/build/target/.venv/.audit-harness`；显式文件范围可以选择被忽略的文件。动态调用、范围外定义、解析/依赖错误及排除文件会保留说明。源码变化检查不覆盖构建配置、依赖和运行环境变化。**静态图不等于完整运行时调用图，也不提供完整污点分析。**

向量检索默认使用固定 revision 的 `multilingual-e5-small` 量化模型，在本机 CPU 生成 384 维归一化向量并按余弦相似度排序。首次使用需下载模型；索引按文件、片段及 hash 增量刷新，删除文件会从索引移除。模型输入最多 512 tokens，长单行可能截断；命中需要回读源码核实。默认索引排除依赖、构建目录和运行数据，单个文件上限 512 KiB。

### 修复资料与前后对照

在线检索区分通告的显式修复链接与关键词候选，保留 URL、抓取时间、版本声明、撤回信息和失败原因。`read_fix_source` 可读 issue/Gist 正文及支持的讨论页，GitHub 自身对大补丁和分页的限制仍然适用。

`verify_fix_source` 分别核对来源、预期仓库/提交与声明引用；`check_fix_applicability` 用 `git apply --check` 正反向检查当前工作树，并按需运行模型编写的条件命令；`compare_patch` 使用两个提交或一个补丁产物，在独立快照中运行相同脚本，保存命令、hash、日志和清单。脚本和外部服务仍具有普通本机执行权限。

本地 Git 工具不自动 fetch 或切换分支。通告版本范围、PR 合并、提交祖先关系、补丁能否应用和脚本退出码分别是证据，最终适用性与漏洞结论仍由模型结合代码和运行条件分析。

## 会话、上下文与持久化

Trace 直接使用 Pi `AgentSession.getContextUsage()` 和 `AgentSession.compact()`，启用原生自动压缩与有限重试（最多 2 次）。

- 当前上下文占用与累计输入/输出 token 分开展示；容量来自任务保存的模型配置。
- 手动压缩只允许在任务空闲时执行，压缩期间拒绝继续或重复压缩，可点击停止取消。
- 压缩后 SDK 占用暂为 `null` 时，页面显示未知，单独展示摘要估算值；下一次真实响应后校准。
- 原始会话追加保存，笔记、发现和报告保留。查看历史上下文通过内存副本恢复，不改写原始 Pi 会话。
- 停止会取消当前 SDK 请求及受管理的命令/语言服务器/向量进程；已脱离进程组的独立 daemon 需另行管理。

```text
.audit-harness/
  config.json                   模型配置与本机保存的凭据
  workspaces.json               工作空间注册
  models/                       embedding 模型缓存
  indexes/<index-id>/           向量索引
  runs/<run-id>/
    run.json                    状态、模型元数据和累计统计
    context.json                上下文与压缩记录
    events.jsonl                可回放的执行事件
    findings.json               模型保存的发现
    notes.md / report.md        笔记与最新报告
    pi/*.jsonl                  Pi 原生会话
    artifacts/                  命令日志、补丁、来源、调用图和实验清单
    experiments/                补丁前后实验快照
```

事件先落盘再通过 SSE 推送，断线按序号续传。历史事件目前整段读取，尚未提供长期日志分页。运行历史、凭据、实验产物和本地验收截图不随公开仓库分发。

## 开发与验证

```bash
npm run check
npm test
npm run build
node --check public/app.js
node --check public/graph.js
npm run smoke:vectors
```

**2026-11-02 本机验证：33 项工程回归全部通过，0 失败、0 跳过；类型检查、构建和前端脚本语法检查通过。** 工程回归覆盖真实子进程、Git 快照、JS/TS、Python、Go、PHP、Java 语言服务器及 Pi 会话恢复。运行完整回归前需安装 `gopls`、JDK 21+ 并运行 `npm run setup:java`；构图回归要求真实服务器，不以跳过代替验收。本地真实向量模型烟雾测试此前通过，本轮未修改其模型逻辑。

向量烟雾测试不调用审计模型；首次执行可能下载 embedding 权重，并在忽略的数据目录写入缓存/索引。

以下脚本需要先启动工作台并配置真实模型，会创建保留历史的联调任务、产生实际模型用量：

| 命令 | 验证内容 |
| --- | --- |
| `npm run smoke` | 本工作台源码审计、工具调用和结果持久化 |
| `npm run smoke:inspection -- /path/to/repo source/file Class.method` | 指定真实项目的符号、引用与本地 Git 工具 |
| `npm run smoke:graph` | 仓库自带 PHP/Java/Python/Go 样例，真实模型构图、四次查询、图产物/页面/变化接口 HTTP 验收 |
| `npm run smoke:advanced` | 语义引用、GitHub/OSV 来源与补丁产物 |
| `node scripts/stop-smoke.mjs` | 真实父子进程与停止；`MANUAL_STOP=1` 等待 Web 手动点击 |
| `npm run smoke:context` | 原生压缩、取消、并发保护与压缩后继续 |
| `npm run smoke:research -- /path/to/dokuwiki` | DokuWiki 的 PHP/调用图/向量/来源工具，以及受控 Git 样例的补丁前后回归 |

从项目根目录执行。`HARNESS_URL` 可覆盖服务地址；`smoke:research` 使用 DokuWiki 的 `inc/auth.php`，目标须包含对应源码，且受控样例目录首次运行时应不存在。`MANUAL_COMPACT=1 MANUAL_RESUME=1` 可让上下文脚本等待界面操作。

此前已记录 DeepSeek 的真实审计、语义/在线修复、停止/续接、重启恢复和手动压缩验收。**四语言静态调用图已通过 `smoke:graph` 的真实模型端到端验收；DokuWiki 的 `smoke:research` 组合仍待执行。** 本轮浏览器实点验收受本机锁屏及 Work 禁用浏览器访问阻断；页面、脚本、图数据和源码变化接口已通过 HTTP 检查，尚未把这写成界面交互通过。详细结果及历史边界见[验收记录](docs/验收记录.md)。

## 项目结构

```text
public/                    原生 Web 界面与调用图查看器
src/server.ts              REST API、SSE、本地服务
src/agent.ts               Pi SDK、模型、会话、停止与压缩
src/tools.ts               项目、命令、发现与笔记工具
src/inspection-tools.ts    分析与修复工具注册
src/code.ts                Tree-sitter 符号、调用点与候选引用
src/semantic.ts            语言服务器管理与语义查询
src/call-graph.ts          调用图构建、查询与快照变化检测
src/vectors.ts             本地向量检索与持久索引
src/source-files.ts        索引范围、文件枚举与 hash
src/git.ts                 版本、历史源码与补丁
src/fix-sources.ts          在线资料、补丁与本地历史关联
src/fix-verification.ts     来源核验、适用条件与补丁对照
src/execution.ts           对照实验的命令执行及日志
src/store.ts               任务、事件、发现及成果持久化
src/workspaces.ts          工作空间注册与旧任务归类
src/config.ts              配置、凭据解析与脱敏
src/context.ts / types.ts  上下文快照和数据类型
scripts/                   本地向量及真实模型验收脚本
test/                      工程回归
docs/                      验收记录
```

主要接口包括 `GET/POST /api/workspaces`、`GET/POST /api/runs`、`GET /api/runs/:id`、`GET /api/runs/:id/events`、`POST /api/runs/:id/continue`、`POST /api/runs/:id/stop`、`GET /api/runs/:id/context`、`POST /api/runs/:id/compact`，以及报告和产物下载接口。

## 当前边界与后续方向

当前重点是可持续使用的本地审计体验。完整污点分析、框架专用实验环境、统一后台服务管理、运行中追加指令、多 Agent、MCP/外部技能配置、源码文件树与跳转、统一产物管理和长期日志分页尚待建设。

优先补齐新增工具的真实模型组合验收，再按真实长任务的卡点改进日志、产物和实验环境管理。历史需求与技术调研见[需求分析、技术选型与开发计划](需求分析、技术选型与开发计划.md)，其中外部项目比较是 2026-10-29 的资料快照，当前实现以本 README 和验收记录为准。

## 基于 Pi 构建

Trace 使用 [`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) 与 `@earendil-works/pi-ai`，感谢 Pi 提供可嵌入的 Agent 运行基础。模型交互、通用工具、会话树和原生压缩由 Pi 支持；本项目实现审计工具、工作空间、证据记录及可视化交互。
