import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, relative, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { analyzeSource, type CodeSymbol } from "./code.js";
import {
  LspClient,
  initializeLanguageServer,
  languageServer,
  located,
} from "./semantic.js";
import { sourceFiles, digest } from "./source-files.js";
import type { RunStore } from "./store.js";
const callable = (s: CodeSymbol) =>
  /function|method|constructor|class_declaration|class_definition/.test(s.kind);
export interface GraphNode extends Partial<CodeSymbol> {
  id: string;
  path: string;
  qualifiedName: string;
  external?: boolean;
}
export interface GraphEdge {
  from: string;
  to: string;
  line: number;
  column: number;
  path: string;
  binding: "definition";
  ambiguous: boolean;
}
export interface CallGraph {
  schema: 1;
  repository: string;
  scope: string;
  generatedAt: string;
  files: { path: string; sha256: string }[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  unresolved: any[];
  errors: any[];
  excluded: any[];
  coverage: any;
  note: string;
}
const contains = (s: Partial<CodeSymbol>, line: number, column: number) =>
  s.startLine !== undefined &&
  (line > s.startLine ||
    (line === s.startLine && column >= (s.startColumn || 1))) &&
  (line < s.endLine! || (line === s.endLine && column <= (s.endColumn || 1)));
export async function buildCallGraph(
  cwd: string,
  args: { scope?: string; timeoutSeconds?: number },
  store: RunStore,
  runId: string,
  callId: string,
  signal?: AbortSignal,
  onProgress?: (value: unknown) => void,
) {
  const deadline = new AbortController();
  const seconds = args.timeoutSeconds ?? 180;
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw Error("timeoutSeconds 必须大于 0");
  const timer = setTimeout(() => deadline.abort(), seconds * 1000);
  const cancel = signal
    ? AbortSignal.any([signal, deadline.signal])
    : deadline.signal;
  try {
    const scan = await sourceFiles(cwd, args.scope, "graph", cancel);
    const graph: CallGraph = {
      schema: 1,
      repository: scan.cwd,
      scope: scan.scope,
      generatedAt: new Date().toISOString(),
      files: [],
      nodes: [],
      edges: [],
      unresolved: [],
      errors: [],
      excluded: scan.excluded,
      coverage: {
        enumerationComplete: scan.enumerationComplete,
        indexedFiles: 0,
        callSites: 0,
        resolvedCallSites: 0,
        staticAnalysisComplete: false,
        runtimeComplete: false,
        selectionRules: scan.rules,
      },
      note: "Project-wide static graph for the declared scope, no depth truncation. Edges use real language-server definitions; callbacks, reflection, dynamic dispatch, dependency/configuration gaps and implicit runtime calls can remain unresolved. runtimeComplete is always false; no universal runtime-completeness claim.",
    };
    const parsed = new Map<string, Awaited<ReturnType<typeof analyzeSource>>>();
    for (const file of scan.files) {
      cancel.throwIfAborted();
      try {
        const syntax = await analyzeSource(file.text, file.language!, cancel);
        parsed.set(file.path, syntax);
        graph.files.push({ path: file.path, sha256: file.sha256 });
        if (syntax.hasSyntaxErrors)
          graph.errors.push({ path: file.path, error: "syntax-errors" });
        graph.nodes.push({
          id: digest(file.path + ":module"),
          path: file.path,
          qualifiedName: "<module>",
          kind: "module",
        });
        for (const symbol of syntax.symbols.filter(callable))
          graph.nodes.push({
            ...symbol,
            path: file.path,
            id: digest(`${file.path}:${symbol.nameLine}:${symbol.nameColumn}`),
          });
      } catch (error) {
        cancel.throwIfAborted();
        graph.errors.push({ path: file.path, error: String(error) });
      }
    }
    const groups = new Map<string, typeof scan.files>();
    for (const file of scan.files) {
      if (!parsed.has(file.path)) continue;
      const list = groups.get(file.language!) || [];
      list.push(file);
      groups.set(file.language!, list);
    }
    for (const files of groups.values()) {
      let client: LspClient | undefined;
      try {
        const first = files[0];
        const { language, command } = languageServer(first.path);
        client = new LspClient(command, scan.cwd, cancel);
        const info = await initializeLanguageServer(
          client,
          scan.cwd,
          first.path,
          language,
          first.text,
        );
        if (!info.capabilities.definitionProvider)
          throw Error("语言服务器未提供语义定义查询");
        for (const file of files.slice(1))
          client.notify("textDocument/didOpen", {
            textDocument: {
              uri: pathToFileURL(file.path).href,
              languageId:
                language === "typescript"
                  ? (/\.[cm]?jsx?$/.test(file.path)
                      ? "javascript"
                      : "typescript") + (file.path.endsWith("x") ? "react" : "")
                  : language,
              version: 1,
              text: file.text,
            },
          });
        for (const file of files) {
          const syntax = parsed.get(file.path)!;
          graph.coverage.indexedFiles++;
          for (const call of syntax.calls) {
            cancel.throwIfAborted();
            graph.coverage.callSites++;
            const parents = graph.nodes.filter(
              (n) =>
                n.path === file.path &&
                contains(n, call.line, call.column) &&
                /function|method|constructor|class_declaration|class_definition/.test(
                  n.kind || "",
                ),
            );
            parents.sort(
              (a, b) =>
                a.endLine! - a.startLine! - (b.endLine! - b.startLine!) ||
                b.startColumn! - a.startColumn!,
            );
            const from = (parents[0] ||
              graph.nodes.find(
                (n) => n.path === file.path && n.kind === "module",
              ))!.id;
            const unresolved = { path: file.path, from, ...call };
            if (call.dynamic) {
              graph.unresolved.push({
                ...unresolved,
                reason: "dynamic-callee",
              });
              continue;
            }
            try {
              const defs = await client.request("textDocument/definition", {
                textDocument: { uri: pathToFileURL(file.path).href },
                position: { line: call.line - 1, character: call.column - 1 },
              });
              const locations = (
                Array.isArray(defs) ? defs : defs ? [defs] : []
              ).map(located);
              const targets: GraphNode[] = [];
              for (const loc of locations) {
                let target = graph.nodes.find(
                  (n) =>
                    n.path === loc.path &&
                    ((n.nameLine === loc.line && n.nameColumn === loc.column) ||
                      (n.startLine === loc.line &&
                        n.startColumn === loc.column)),
                );
                if (!target && loc.path && !parsed.has(loc.path)) {
                  // Outside the indexed scope: retain a semantic boundary, never infer its body.
                  const id = digest(`${loc.uri}:${loc.line}:${loc.column}`);
                  target = graph.nodes.find((n) => n.id === id);
                  if (!target) {
                    target = {
                      id,
                      path: loc.path,
                      qualifiedName: call.text,
                      nameLine: loc.line,
                      nameColumn: loc.column,
                      kind: "external-definition",
                      external: true,
                    };
                    graph.nodes.push(target);
                  }
                }
                if (
                  target &&
                  /new_expression|object_creation_expression/.test(call.kind) &&
                  /class/.test(target.kind || "")
                ) {
                  const constructor = graph.nodes.find(
                    (n) =>
                      n.path === target!.path &&
                      [
                        target!.qualifiedName + ".constructor",
                        target!.qualifiedName + ".__construct",
                        target!.qualifiedName + "." + target!.name,
                      ].includes(n.qualifiedName),
                  );
                  if (constructor) target = constructor;
                }
                if (target && !targets.some((t) => t.id === target!.id))
                  targets.push(target);
              }
              if (!targets.length)
                graph.unresolved.push({
                  ...unresolved,
                  reason: locations.length
                    ? "definition-is-not-an-indexed-callable"
                    : "no-definition",
                  definitions: locations,
                });
              else {
                graph.coverage.resolvedCallSites++;
                for (const to of targets)
                  graph.edges.push({
                    from,
                    to: to.id,
                    path: file.path,
                    line: call.line,
                    column: call.column,
                    binding: "definition",
                    ambiguous: targets.length > 1,
                  });
              }
            } catch (error) {
              cancel.throwIfAborted();
              graph.unresolved.push({
                ...unresolved,
                reason: "definition-error",
                error: String(error),
              });
            }
          }
          onProgress?.({
            phase: "call-graph",
            file: relative(scan.cwd, file.path),
            ...graph.coverage,
          });
        }
        const diagnostics = [...client.diagnostics.entries()].flatMap(
          ([uri, items]) =>
            items
              .filter((d) => d.severity === 1)
              .map((d) => ({ uri, error: d.message })),
        );
        graph.errors.push(...diagnostics);
      } catch (error) {
        signal?.throwIfAborted();
        graph.errors.push({
          paths: files.map((f) => f.path),
          error: deadline.signal.aborted ? "analysis-timeout" : String(error),
        });
      } finally {
        client?.dispose();
      }
      if (cancel.aborted) break;
    }
    graph.coverage.staticAnalysisComplete =
      scan.enumerationComplete &&
      graph.errors.length === 0 &&
      graph.excluded.length === 0 &&
      graph.coverage.indexedFiles === graph.files.length &&
      graph.unresolved.length === 0;
    const name = `call-graph-${callId.replace(/[^\w-]/g, "_")}.json`;
    mkdirSync(resolve(store.dir(runId), "artifacts"), { recursive: true });
    writeFileSync(
      resolve(store.dir(runId), "artifacts", name),
      JSON.stringify(graph),
      { mode: 0o600 },
    );
    return {
      artifact: name,
      viewerUrl: `/graph.html?run=${encodeURIComponent(runId)}&artifact=${encodeURIComponent(name)}`,
      scope: graph.scope,
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      unresolved: graph.unresolved.length,
      coverage: graph.coverage,
      errors: graph.errors,
      excluded: graph.excluded,
      note: graph.note,
    };
  } finally {
    clearTimeout(timer);
  }
}
export function queryCallGraph(
  cwd: string,
  args: {
    artifact: string;
    symbol?: string;
    path?: string;
    direction?: "incoming" | "outgoing" | "both";
    transitive?: boolean;
    offset?: number;
    limit?: number;
  },
  store: RunStore,
  runId: string,
) {
  if (
    basename(args.artifact) !== args.artifact ||
    !args.artifact.startsWith("call-graph-")
  )
    throw Error("请选择该任务生成的调用图产物");
  const graph: CallGraph = JSON.parse(
    readFileSync(resolve(store.dir(runId), "artifacts", args.artifact), "utf8"),
  );
  const selected = graph.nodes.filter(
    (n) =>
      (!args.symbol || n.qualifiedName.includes(args.symbol)) &&
      (!args.path || n.path === resolve(cwd, args.path)),
  );
  const reached = new Set(selected.map((n) => n.id));
  const edges = new Set<GraphEdge>();
  let added = true;
  while (added) {
    added = false;
    for (const edge of graph.edges) {
      const match =
        (args.direction !== "incoming" && reached.has(edge.from)) ||
        (args.direction !== "outgoing" && reached.has(edge.to));
      if (match) {
        edges.add(edge);
        for (const id of [edge.from, edge.to])
          if (!reached.has(id) && args.transitive) {
            reached.add(id);
            added = true;
          }
      }
    }
    if (!args.transitive) break;
  }
  const stale = graph.files
    .filter((f) => {
      try {
        return digest(readFileSync(f.path, "utf8")) !== f.sha256;
      } catch {
        return true;
      }
    })
    .map((f) => f.path);
  const all = [...edges];
  const offset = args.offset ?? 0,
    limit = args.limit ?? 100;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit <= 0
  )
    throw Error("无效分页");
  return {
    selected,
    edges: all.slice(offset, offset + limit),
    nodes: graph.nodes.filter(
      (n) =>
        selected.some((s) => s.id === n.id) ||
        all.some((e) => e.from === n.id || e.to === n.id),
    ),
    totalEdges: all.length,
    nextOffset: offset + limit < all.length ? offset + limit : null,
    unresolved: graph.unresolved.filter((v) => reached.has(v.from)),
    staleFiles: stale,
    coverage: graph.coverage,
    note: graph.note,
  };
}
