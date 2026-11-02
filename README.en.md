# Trace · Agent Code Audit Harness

**A local code audit harness built on [Pi SDK](https://github.com/earendil-works/pi).** Let an agent read real source code, follow calls, write and run experiments, inspect fixes, and continue an audit in a persistent session.

[简体中文（主文档）](README.md) · **English**

Trace reuses Pi's model integration, tool execution, file sessions, and context compaction. It adds audit tools, project workspaces, evidence storage, and a web workbench. The model chooses how to investigate and validate; the harness connects information, execution, and durable progress.

Version `0.1.0` uses **Pi SDK 1.4.0** and is intended for local, single-user operation. Model output, tool calls, findings, and status in the interface come from actual execution. The interface and audit system prompt currently use Chinese.

## Capabilities

- **Read and follow code:** syntax-tree outlines, symbol reads, candidate references, language-server references, and a queryable static call graph with a web viewer.
- **Find code in natural language:** local neural embeddings for source and documentation, including Chinese queries, scoped indexing, and incremental updates.
- **Test hypotheses:** ordinary shell and file tools plus exact argv execution, timeouts, cancellation, and complete output logs. The model can write probes and focused tests.
- **Inspect fix evidence:** local Git history, GitHub/OSV records and patches, source identity and reference checks, local applicability checks, and before/after experiments on separate Git snapshots.
- **Continue long audits:** project workspaces, live traces, findings, notes, reports, stop/resume, restart recovery, context compaction, and Markdown export.

## Quick start

Install **Node.js 22.22.2+**, npm, and have a local source directory to audit. Local validation used Node.js `24.18.0`.

Install `rg` (ripgrep). Git tools require `git`; online source tools require `curl`. Prepare the target's Python, PHP, Java, Go, dependencies, and build tools as needed. Tree-sitter uses precompiled WASM.

```bash
git clone https://github.com/Junt184/trace-audit-harness.git
cd trace-audit-harness
npm ci
npm run dev
```

Open **http://127.0.0.1:4317**. Use the model settings in the top right to configure an endpoint, model, and API key. Testing the connection makes a real model request.

Alternatively, configure an environment file:

```bash
cp .env.example .env
# Edit .env with your own model settings and credentials.
npm run dev
```

For a compiled start:

```bash
npm run build
npm start
```

Development mode does not restart automatically. Restart after backend TypeScript changes; refresh after frontend changes. Press Ctrl+C to stop the server.

## Model and network configuration

The default configuration is below. `deepseek-flash` is the model ID used in recorded live validation; select an ID actually available from your provider.

```dotenv
MODEL_PROVIDER=deepseek
MODEL_BASE_URL=https://api.deepseek.com/v1
MODEL_ID=deepseek-flash
MODEL_API=openai-completions
DEEPSEEK_API_KEY=
GITHUB_PROXY=http://127.0.0.1:7890
```

Configurable protocols are Chat Completions (`openai-completions`), Responses (`openai-responses`), and Anthropic Messages (`anthropic-messages`). Compatible services must support tool calls. Recorded end-to-end validation primarily covers DeepSeek Chat Completions; other providers still need validation.

Model fields saved in the workbench override `.env`. Credential precedence is: saved key → `MODEL_API_KEY` → provider-specific environment variable → available local DSH DeepSeek credentials. The optional DSH fallback only reads `~/.dsh/.credentials.yaml`; disable it with `USE_DSH_CREDENTIALS=false`. To return to environment-managed configuration, stop the server, then back up and move `.audit-harness/config.json`.

Set the context window and maximum output tokens in the model settings. Defaults are `131072` and `8192`. A configured window does not establish the provider's actual capacity.

| Variable | Default or purpose |
| --- | --- |
| `PORT` | `4317`; the server only listens on `127.0.0.1` |
| `DEFAULT_REPO` | Default source directory; defaults to this project |
| `AUDIT_DATA_DIR` | `.audit-harness`; configuration, sessions, artifacts, indexes, and model cache |
| `MODEL_API_KEY` | Generic key; official endpoints also support `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, or `ANTHROPIC_API_KEY` |
| `GITHUB_PROXY` | GitHub request proxy; defaults to `http://127.0.0.1:7890` |
| `OSV_PROXY` | Defaults to the GitHub proxy; set explicitly to an empty string for direct OSV requests |
| `GITHUB_TOKEN` | Optional server-side GitHub source-request token for higher API limits |
| `USE_DSH_CREDENTIALS` | Enabled by default; `false` disables the DSH fallback |
| `GOPLS_PATH` | Optional path to `gopls` |
| `AUDIT_LSP_SERVERS` | Per-language command overrides; Java commands can use `{workspace}` for a temporary directory |
| `JDTLS_HOME` / `JAVA_HOME` | Optional JDT LS distribution and JDK 21+ for launching the server |
| `AUDIT_EMBED_MODEL` | `Xenova/multilingual-e5-small` |
| `AUDIT_EMBED_REVISION` | Pinned in source for the default model; `main` for a custom model unless specified |
| `AUDIT_EMBED_PROXY` | Defaults to the GitHub proxy; an explicit empty string downloads models directly |

**Adjust networking for your machine.** GitHub tools currently default to a local proxy; online queries fail if it is unavailable. An empty `GITHUB_PROXY` still selects the default address. OSV and embedding downloads can each use an explicitly empty proxy for direct access. Model requests go directly to the configured provider by default.

Keys saved through the interface are stored in the local configuration with `0600` permissions. The configuration API does not return the key, and run metadata does not store it. Git ignores `.env`, run data, model caches, and indexes.

## Run an audit

1. Select or create a workspace using a local source directory. The same canonical directory reuses its workspace.
2. Enter a focused goal, or use the symbol, fix comparison, semantic reference, online fix, call graph, or vector search prompt shortcuts.
3. Start the audit and inspect model output, tool arguments, and results in the trace. Tool cards link to complete logs, patches, sources, and graph artifacts.
4. Read saved findings, reports, and notes. The report is the latest nonempty final answer; previous answers remain in the trace.
5. Stop an active run when needed. When idle, add an instruction and continue the same Pi session, or compact its context first.
6. Export the report as Markdown. Refreshing or restarting preserves history; unfinished runs become interrupted and can be continued manually.

Start with one module, for example:

> Audit the upload module in read-only mode. Trace how filenames become storage paths. Read related code and tests; write a minimal probe in the audit artifacts directory if useful. Record supported candidates, prerequisites, and validation limits. Save counterevidence and next steps in the notes.

Workspaces organize records by source directory. Switching projects or views does not stop a background audit. The model retains shell and file editing tools; a workspace does not isolate processes or filesystem access.

## Tools

Pi provides `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`. Trace registers **19 additional audit tools**, for 26 tool entries in total.

| Tool | Purpose |
| --- | --- |
| `project_overview` | Directory, Git revision, and working-tree state |
| `code_outline` | Tree-sitter symbols, qualified names, and exact ranges; pagination and Git revisions |
| `read_symbol` | Read functions/classes/methods with line numbers, hashes, disambiguation, and historical versions |
| `find_references` | Same-name candidate occurrences and caller context, filtering comments/strings |
| `semantic_references` | Real language-server definitions and references at a source cursor |
| `build_call_graph` | Scoped static graph with nodes, call edges, coverage, and unresolved calls |
| `query_call_graph` | Incoming/outgoing and transitive relationships, plus source-change detection |
| `semantic_search` | Local neural retrieval with excerpts, ranges, hashes, and similarity scores |
| `git_refs` | Local branches, remote-tracking branches, and tags |
| `git_history` | Search local commit messages, changed text, and paths |
| `git_patch` | Commit patches or version differences, with pagination and captured artifacts |
| `search_fix_sources` | GitHub advisories, commit/issue/PR candidates, and OSV package-version queries |
| `read_fix_source` | GHSA, commit, PR, issue, Gist, and OSV records; raw evidence and available patches |
| `verify_fix_source` | Separate source identity, repository, commit, and explicit reference checks |
| `check_fix_applicability` | Read-only forward/reverse patch checks, dependency/config evidence, and model-written runtime conditions |
| `compare_patch` | Identical scripts on separate Git snapshots, with before/after output and assertions |
| `run_command` | Exact argv execution, full logs, timeouts, and process-group cancellation |
| `record_finding` | Persist or update severity, status, evidence, prerequisites, and recommendations |
| `audit_notes` | Durable progress, rejected hypotheses, and next steps |

### Languages and analysis

| Language | Syntax-tree symbol reads | Semantic definitions/references |
| --- | --- | --- |
| JavaScript / TypeScript / TSX | Supported | Bundled typescript-language-server; engineering regression passed |
| Python | Supported | Bundled Pyright; engineering regression passed |
| Go | Supported | Requires local `gopls` and project toolchain/dependencies; local regression passed |
| PHP / PHTML | Supported | Bundled Intelephense; PHP cross-file references and graph edges passed regression |
| Java | Supported | Pinned JDT LS; Maven cross-file references, constructors, overloads, and call chains verified locally |

`semantic_references` uses 1-based lines and columns, with UTF-16 columns pointing inside an identifier. `projectRoot` overrides automatic root discovery. A semantic query starts its own language server and closes it on completion or cancellation. Large projects may load slowly; the default timeout is 90 seconds.

For Java, install JDK 21+ and provision the server once:

```bash
npm run setup:java
# With a proxy: HTTPS_PROXY=http://127.0.0.1:7890 npm run setup:java
```

The installer downloads Eclipse JDT LS `1.63.0`, verifies a pinned SHA-256, and stores it in ignored `.audit-harness/servers/`. `JDTLS_HOME` selects an existing distribution; otherwise a missing local installation falls back to `jdtls` on PATH. `JAVA_HOME` selects the server JDK; prepare the target JDK and dependencies using the project's own build configuration. Java requests wait for `language/status: Started`. The default launcher isolates configuration/workspace directories per invocation, removes them on exit, and redirects newly generated Eclipse metadata there. Custom `AUDIT_LSP_SERVERS.java` commands must provide equivalent options; `{workspace}` expands to an invocation-specific temporary directory. Java verification currently covers a Maven sample, not every Gradle, framework, or dependency combination.

The call graph workflow is:

1. Use the call graph prompt shortcut and select a scope. The model invokes `build_call_graph(scope=".",timeoutSeconds=180)`, groups files by language/project root, parses calls, and binds targets with language-server definitions.
2. Open the full JSON or web viewer from the tool card. Search symbols, explore direct/transitive neighbors, inspect signatures and precise call locations, and download the graph.
3. Query with `query_call_graph`, specifying `artifact`, `symbol`, `path`, `direction`, and `transitive`. Traversal handles cycles and pagination. Queries enumerate the original scope again, returning changed/deleted `staleFiles`, new `addedFiles`, and `freshness`. The viewer checks automatically and offers a source-change check button. Rebuild after changes.
4. Server failures or deadlines preserve an explicit partial graph: every extracted call is resolved or recorded as unresolved. User cancellation terminates the active server and rejects the tool without saving that unfinished graph.

PHP, Java, Python, and Go passed one real-model build and four call-chain queries: 9 source files, 13 call sites, 12 bound edges, and 1 explicit unresolved callback. This uses committed controlled samples; TypeScript has separate real-server regression coverage. Enumeration follows rg ignore rules and excludes dependency/build directories at every depth, including `node_modules/vendor/dist/build/target/.venv/.audit-harness`; explicit file scopes can select ignored files. Dynamic calls, outside-scope definitions, syntax/dependency failures, and exclusions remain visible. Freshness checks cover sources, not build configuration, dependency, or runtime changes. **A static graph is not a complete runtime graph or a full taint analysis.**

Vector search defaults to a pinned, quantized `multilingual-e5-small` model running on the local CPU, producing normalized 384-dimensional embeddings ranked by cosine similarity. First use downloads weights. File and chunk hashes support incremental refresh; deleted files leave the index. Model input is capped at 512 tokens, so long individual lines may be truncated. Verify hits against the source. Dependencies, build output, and run data are excluded by default; individual indexed files are limited to 512 KiB.

### Fix evidence and regression experiments

Online search distinguishes explicit advisory fix links from keyword candidates. Results retain URLs, fetch times, version claims, withdrawn state, and failures. `read_fix_source` supports issue/Gist bodies and available discussion pages; upstream pagination and large-patch limits still apply.

`verify_fix_source` separately checks identity, expected repository/commit, and claimed references. `check_fix_applicability` runs forward/reverse `git apply --check` against the working tree and optional model-written condition commands. `compare_patch` uses two commits or a saved patch, runs the same script in separate snapshots, and saves commands, hashes, logs, and a manifest. Scripts and external services retain ordinary local execution permissions.

Local Git tools do not automatically fetch or switch branches. Advisory ranges, PR merges, commit ancestry, patch matching, and script exit codes are separate evidence; the model must assess local applicability and vulnerability impact using code and runtime conditions.

## Sessions, context, and persistence

Trace directly uses Pi's `AgentSession.getContextUsage()` and `AgentSession.compact()`, with native auto-compaction and up to two retries.

- Current context usage is separate from cumulative input/output tokens; capacity comes from the run's saved model configuration.
- Manual compaction requires an idle audit. Continue and duplicate compaction requests are rejected while compacting; stop cancels it.
- When the SDK returns `null` after compaction, usage stays unknown and the summary estimate is shown separately. A subsequent real response recalibrates it.
- Original sessions are appended to; findings, notes, and reports remain available. Historical context inspection restores an in-memory copy without rewriting the original Pi session.
- Stop cancels the SDK request and managed command/language-server/vector processes. Independent daemons that detached from a process group require separate management.

```text
.audit-harness/
  config.json                   Model configuration and locally saved credentials
  workspaces.json               Workspace registry
  models/                       Embedding model cache
  indexes/<index-id>/            Vector indexes
  runs/<run-id>/
    run.json                    Status, model metadata, cumulative usage
    context.json                Context and compaction records
    events.jsonl                Replayable execution events
    findings.json               Model-recorded findings
    notes.md / report.md        Notes and latest report
    pi/*.jsonl                  Native Pi sessions
    artifacts/                  Logs, patches, sources, graphs, experiment manifests
    experiments/                Before/after snapshot directories
```

Events are persisted before SSE delivery, with sequence-based reconnection. History is currently read in full; long-term event pagination is pending. Public source does not include local credentials, run histories, experiment artifacts, or local validation screenshots.

## Development and validation

```bash
npm run check
npm test
npm run build
node --check public/app.js
node --check public/graph.js
npm run smoke:vectors
```

**Local verification on 2026-11-02: all 33 engineering tests passed, with no failures or skips; type checking, build, and frontend syntax checks passed.** Tests cover real child processes, Git snapshots, JS/TS, Python, Go, PHP, and Java language servers, and Pi session recovery. Install `gopls`, JDK 21+, and run `npm run setup:java` before the full suite; graph tests require real servers. The real local vector smoke test passed previously; this change does not modify the embedding model logic.

The vector smoke test does not call the audit model. First use may download embedding weights and write cache/index files to the ignored data directory.

The following scripts require a running workbench and a configured real model. They create retained validation runs and consume actual model usage:

| Command | Coverage |
| --- | --- |
| `npm run smoke` | Workbench source audit, tools, and persistence |
| `npm run smoke:inspection -- /path/to/repo source/file Class.method` | Symbol/reference/local Git tools in a real repository |
| `npm run smoke:graph` | Real-model graph build and four queries over committed PHP/Java/Python/Go samples; graph/viewer/freshness HTTP checks |
| `npm run smoke:advanced` | Semantic references, GitHub/OSV sources, and patch artifacts |
| `node scripts/stop-smoke.mjs` | Real parent/child cancellation; `MANUAL_STOP=1` waits for a web click |
| `npm run smoke:context` | Native compaction, cancellation, concurrency guards, and resume |
| `npm run smoke:research -- /path/to/dokuwiki` | DokuWiki PHP/graph/vector/source tools and patch regression on a controlled Git sample |

Run from the project root. `HARNESS_URL` overrides the server address. The research script expects DokuWiki's `inc/auth.php` and a fresh controlled-sample directory. Set `MANUAL_COMPACT=1 MANUAL_RESUME=1` for manual context UI steps.

Earlier records cover real DeepSeek audits, semantic/online fix tools, stop/resume, restart recovery, and manual compaction. **The four-language graph passed real-model end-to-end acceptance with `smoke:graph`; the larger DokuWiki `smoke:research` combination remains pending.** Interactive browser verification was blocked by the locked Mac and disabled browser access in Work settings. Viewer assets, graph data, and freshness endpoints were checked over HTTP; UI interaction is not claimed as verified. See the [validation record, in Chinese](docs/验收记录.md) for evidence and historical boundaries.

## Project structure

```text
public/                    Web interface and graph viewer
src/server.ts              REST API, SSE, local server
src/agent.ts               Pi SDK, model, sessions, stop, compaction
src/tools.ts               Project, command, findings, notes tools
src/inspection-tools.ts    Analysis and fix-tool registration
src/code.ts                Tree-sitter symbols, calls, candidate references
src/semantic.ts            Language-server lifecycle and semantic queries
src/call-graph.ts          Graph building, traversal, source-change checks
src/vectors.ts             Local retrieval and persistent indexes
src/source-files.ts        Scoped file enumeration and hashes
src/git.ts                 Versions, historical source, patches
src/fix-sources.ts          Online sources, patches, local ancestry
src/fix-verification.ts     Source/applicability checks and patch comparisons
src/execution.ts           Experiment commands and logs
src/store.ts               Runs, events, findings, durable output
src/workspaces.ts          Workspace registry and legacy run migration
src/config.ts              Configuration, credential resolution, redaction
src/context.ts / types.ts  Context snapshots and data types
scripts/                   Vector and real-model validation scripts
test/                      Engineering regression tests
docs/                      Validation record
```

Main endpoints include `GET/POST /api/workspaces`, `GET/POST /api/runs`, `GET /api/runs/:id`, `GET /api/runs/:id/events`, `POST /api/runs/:id/continue`, `POST /api/runs/:id/stop`, `GET /api/runs/:id/context`, `POST /api/runs/:id/compact`, and report/artifact download routes.

## Current limits and next steps

Pending work includes full taint analysis, framework-specific labs, background service management, instructions during active execution, multi-agent orchestration, MCP/external skill configuration, a source tree and source navigation, unified artifact management, and long-term log pagination.

The next priority is combined real-model validation of new tools, followed by log, artifact, and environment improvements driven by real long audits. The [requirements and architecture notes, in Chinese](需求分析、技术选型与开发计划.md) contain external-project research dated 2026-10-29. This README and the validation record describe the current implementation.

## Built on Pi

Trace uses [`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) and `@earendil-works/pi-ai`. Thanks to Pi for the embeddable agent runtime: model interaction, general tools, session trees, and native compaction. Trace adds audit tools, workspaces, evidence storage, and visual interaction.
