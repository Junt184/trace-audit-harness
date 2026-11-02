import { marked } from "/vendor/marked.js";
import DOMPurify from "/vendor/purify.js";

const $ = (selector) => document.querySelector(selector);
const state = {
  config: null,
  runs: [],
  run: null,
  findings: [],
  context: null,
  events: [],
  stream: null,
  lastSeq: 0,
  nodes: new Map(),
  loading: false,
  browsing: null,
  page: "trace",
  isNew: true,
  workspaces: [],
  workspace: null,
  navigation: 0,
};
const labels = {
  starting: "正在启动",
  running: "审计进行中",
  stopping: "正在停止",
  compacting: "正在压缩上下文",
  completed: "本轮完成",
  stopped: "已停止",
  failed: "执行失败",
  interrupted: "执行中断",
};
const active = (status) =>
  ["starting", "running", "stopping", "compacting"].includes(status);
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const markdown = (text) =>
  DOMPurify.sanitize(marked.parse(text || "", { breaks: true }));
const textOf = (result) =>
  typeof result === "string"
    ? result
    : (result?.content || [])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n") || JSON.stringify(result, null, 2);
const time = (value) =>
  new Date(value).toLocaleTimeString("zh-CN", { hour12: false });
const formatNumber = (n) =>
  n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
let toastTimer, renderTimer, repoTimer;

function toast(text) {
  $("#toast").textContent = text;
  $("#toast").classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#toast").classList.remove("visible"), 5000);
}
async function api(path, body) {
  const response = await fetch(
    path,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}
function busy(button, value, label) {
  button.disabled = value;
  if (label) button.textContent = label;
}
function empty(title, description, symbol = "◇") {
  return `<div class="empty-result"><div class="empty-symbol">${symbol}</div><strong>${escape(title)}</strong><p>${escape(description)}</p></div>`;
}

async function loadConfig() {
  state.config = await api("/api/config");
  $("#model-name").textContent = state.config.model;
  $("#launch-model").textContent = state.config.hasApiKey
    ? `${state.config.model} · 已配置`
    : "请先配置模型连接";
  if (!$("#repository").value)
    $("#repository").value = state.config.defaultRepository;
  $("#connection").innerHTML = '<span class="live-dot"></span> 本地服务已连接';
  $("#connection").classList.remove("disconnected");
}
const pages = {
  tasks: "审计任务",
  trace: "执行轨迹",
  findings: "发现",
  report: "报告",
  notes: "笔记",
};
const preference = {
  get(key) {
    try {
      return localStorage.getItem("trace." + key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem("trace." + key, value);
    } catch {}
  },
};
function updateLocation() {
  const params = new URLSearchParams();
  if (state.workspace) params.set("workspace", state.workspace.id);
  if (state.run && !state.isNew) params.set("run", state.run.id);
  params.set("view", state.isNew ? "new" : state.page);
  history.replaceState(null, "", "/?" + params);
}
function renderWorkspaces() {
  const workspace = state.workspace;
  $("#workspace-name").textContent = workspace?.name || "选择项目";
  $("#workspace-avatar").textContent =
    workspace?.name.slice(0, 1).toUpperCase() || "▱";
  $("#workspace-button").title =
    workspace?.repository || "选择或创建项目工作空间";
  $("#sidebar-repository").textContent =
    workspace?.repository || "尚未选择项目";
  $("#sidebar-repository").title = workspace?.repository || "";
  $("#breadcrumb-project").textContent = workspace?.name || "工作台";
  $("#workspace-active").textContent = workspace?.activeCount
    ? `${workspace.activeCount} 个审计运行中 · 查看任务`
    : "";
  $("#workspace-active").classList.toggle("hidden", !workspace?.activeCount);
  $("#workspace-list").innerHTML = state.workspaces.length
    ? state.workspaces
        .map(
          (w) =>
            `<button type="button" class="workspace-option ${workspace?.id === w.id ? "selected" : ""}" data-workspace="${escape(w.id)}"><span class="workspace-avatar">${escape(w.name.slice(0, 1).toUpperCase())}</span><span><strong>${escape(w.name)}</strong><small>${escape(w.repository)}</small></span><span class="workspace-option-count">${w.activeCount ? `${w.activeCount} 运行中` : `${w.runCount || 0} 个审计`}</span></button>`,
        )
        .join("")
    : '<div class="history-empty">还没有项目，关联一个本机源码目录开始。</div>';
}
function renderNavigation() {
  const page = state.page;
  $("#welcome").classList.toggle("hidden", !state.isNew);
  $("#tasks-view").classList.toggle("hidden", state.isNew || page !== "tasks");
  $("#run-view").classList.toggle(
    "hidden",
    state.isNew || page === "tasks" || !state.run,
  );
  $("#session-strip").classList.toggle(
    "hidden",
    state.isNew || page === "tasks",
  );
  $("#no-run-view").classList.toggle(
    "hidden",
    state.isNew || page === "tasks" || Boolean(state.run),
  );
  $("#section-title").textContent = pages[page];
  $("#breadcrumb-title").textContent = state.isNew ? "新建审计" : pages[page];
  for (const button of document.querySelectorAll("[data-page]")) {
    const selected = !state.isNew && button.dataset.page === page;
    button.classList.toggle("active", selected);
    if (selected) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  $(".execution-panel").classList.toggle("hidden", page !== "trace");
  $(".results-panel").classList.toggle("hidden", page === "trace");
  $("#result-title").textContent = pages[page];
  $("#result-description").textContent =
    {
      findings: "候选、证据与验证状态",
      report: "本轮结论与审计范围",
      notes: "持久线索与下一步",
    }[page] || "";
  for (const name of ["findings", "report", "notes"])
    $(`#${name}-panel`).classList.toggle("hidden", page !== name);
  $("#no-run-content").innerHTML = empty(
    `还没有${pages[page] || "审计记录"}`,
    "为当前工作空间启动一次审计后，这里会展示对应内容。",
  );
}
function clearRun() {
  state.stream?.close();
  state.stream = null;
  state.run = null;
  state.context = null;
  state.findings = [];
  state.report = "";
  state.notes = "";
  state.events = [];
  state.nodes.clear();
  state.lastSeq = 0;
  $("#timeline").innerHTML = "";
  renderResults();
}
async function refreshRuns() {
  const workspaceId = state.workspace?.id;
  const [workspaces, runs] = await Promise.all([
    api("/api/workspaces"),
    workspaceId
      ? api("/api/runs?workspaceId=" + encodeURIComponent(workspaceId))
      : Promise.resolve([]),
  ]);
  if (state.workspace?.id !== workspaceId) return;
  state.workspaces = workspaces;
  state.workspace = workspaces.find((w) => w.id === workspaceId) || null;
  state.runs = runs;
  const current = runs.find((run) => run.id === state.run?.id);
  if (current) {
    state.run = current;
    renderRun();
    void refreshContext(current.id);
  }
  renderHistory();
  renderWorkspaces();
}
setInterval(() => {
  if (!document.hidden) void refreshRuns().catch(() => {});
}, 5000);
function renderHistory() {
  $("#run-count").textContent = state.runs.length;
  $("#run-list").innerHTML = state.runs.length
    ? state.runs
        .map(
          (run) =>
            `<button class="task-card ${state.run?.id === run.id ? "selected" : ""}" data-run="${escape(run.id)}"><span class="task-icon">${active(run.status) ? "◌" : "⌁"}</span><span class="task-info"><strong>${escape(run.title)}</strong><span>${escape(run.goal)}</span><small>${new Date(run.createdAt).toLocaleString("zh-CN")} · ${run.toolCalls} 次工具调用 · ${escape(run.model)}</small></span><span class="status-badge ${escape(run.status)}">${escape(labels[run.status])}</span><span class="task-arrow">↗</span></button>`,
        )
        .join("")
    : empty("这个项目还没有审计任务", "点击新建审计，填写目标后开始。");
  const select = $("#run-select");
  select.innerHTML = state.runs.length
    ? state.runs
        .map(
          (run) =>
            `<option value="${escape(run.id)}">${escape(run.title)} · ${escape(labels[run.status])}</option>`,
        )
        .join("")
    : '<option value="">暂无审计任务</option>';
  select.disabled = !state.runs.length;
  if (state.run) select.value = state.run.id;
}
async function selectWorkspace(id, { newAudit = false } = {}) {
  const workspace = state.workspaces.find((w) => w.id === id);
  if (!workspace) return;
  const token = ++state.navigation;
  clearRun();
  state.workspace = workspace;
  state.runs = [];
  preference.set("workspace", id);
  $("#repository").value = workspace.repository;
  $("#repo-detail").textContent = "正在读取项目…";
  renderWorkspaces();
  renderHistory();
  await refreshRuns();
  if (token !== state.navigation) return;
  void inspectRepository();
  const remembered = preference.get("run." + id);
  const target = state.runs.find((r) => r.id === remembered) || state.runs[0];
  if (newAudit || !target) showNew();
  else await openRun(target.id, state.page);
}
function showNew() {
  ++state.navigation;
  clearRun();
  state.isNew = true;
  $("#goal").value = "";
  $("#repository").value = state.workspace?.repository || "";
  renderNavigation();
  renderHistory();
  updateLocation();
  if (!state.workspace) openWorkspaces();
}
async function navigate(page) {
  if (!pages[page]) return;
  state.page = page;
  state.isNew = false;
  if (!state.run && page !== "tasks" && state.runs.length)
    return openRun(state.runs[0].id, page);
  renderNavigation();
  updateLocation();
}
function openWorkspaces() {
  renderWorkspaces();
  if (!$("#workspace-repository").value)
    $("#workspace-repository").value = state.config?.defaultRepository || "";
  $("#workspace-modal").showModal();
}
$("#workspace-button").addEventListener("click", openWorkspaces);
$("#workspace-list").addEventListener("click", async (event) => {
  const id = event.target.closest("[data-workspace]")?.dataset.workspace;
  if (!id) return;
  $("#workspace-modal").close();
  try {
    await selectWorkspace(id);
  } catch (error) {
    toast(error.message);
  }
});
$("#workspace-create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#create-workspace");
  busy(button, true);
  try {
    const workspace = await api("/api/workspaces", {
      name: $("#workspace-project-name").value,
      repository: $("#workspace-repository").value.trim(),
    });
    state.workspaces = await api("/api/workspaces");
    $("#workspace-modal").close();
    $("#workspace-project-name").value = "";
    await selectWorkspace(workspace.id, { newAudit: true });
    toast("已打开工作空间：" + workspace.name);
  } catch (error) {
    toast(error.message);
  } finally {
    busy(button, false);
  }
});
$("#audit-nav").addEventListener("click", (event) => {
  const page = event.target.closest("[data-page]")?.dataset.page;
  if (page) void navigate(page);
});
$("#run-select").addEventListener("change", (event) => {
  if (event.target.value) void openRun(event.target.value, state.page);
});
$("#tasks-new").addEventListener("click", showNew);
$("#empty-new").addEventListener("click", showNew);
$("#workspace-active").addEventListener("click", () => void navigate("tasks"));
async function inspectRepository() {
  const path = $("#repository").value.trim();
  if (!path) return;
  try {
    const repo = await api("/api/repository?path=" + encodeURIComponent(path));
    if ($("#repository").value.trim() !== path) return;
    $("#repo-detail").textContent = repo.isGit
      ? `${repo.name} · ${repo.branch || "detached"} · ${repo.commit} · ${repo.dirtyFiles} 个变更`
      : `${repo.name} · 本地源码目录 · ${repo.entries.length} 个顶层条目`;
    $("#repo-detail").className = "field-help success";
  } catch (error) {
    if ($("#repository").value.trim() !== path) return;
    $("#repo-detail").textContent = error.message;
    $("#repo-detail").className = "field-help error";
  }
}
$("#repository").addEventListener("input", () => {
  clearTimeout(repoTimer);
  repoTimer = setTimeout(inspectRepository, 400);
});

$("#create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.config?.hasApiKey) {
    openSettings();
    return;
  }
  const button = $("#launch-button");
  busy(button, true, "正在启动…");
  try {
    const run = await api("/api/runs", {
      workspaceId: state.workspace?.id,
      repository: $("#repository").value.trim(),
      goal: $("#goal").value.trim(),
    });
    await openRun(run.id, "trace");
    await refreshRuns();
  } catch (error) {
    toast(error.message);
  } finally {
    busy(button, false, "开始审计 ↗");
  }
});

async function openRun(id, page = "trace") {
  const token = ++state.navigation;
  state.stream?.close();
  state.loading = true;
  try {
    const data = await api("/api/runs/" + id);
    if (token !== state.navigation) return;
    const workspace = state.workspaces.find(
      (w) => w.id === data.run.workspaceId,
    );
    if (!workspace) throw new Error("该审计所属的工作空间不存在");
    state.workspace = workspace;
    state.isNew = false;
    state.page = pages[page] ? page : "trace";
    preference.set("workspace", workspace.id);
    preference.set("run." + workspace.id, id);
    $("#repository").value = workspace.repository;
    state.run = data.run;
    state.context = null;
    state.findings = data.findings;
    state.notes = data.notes;
    state.report = data.report;
    state.events = [];
    state.lastSeq = 0;
    state.nodes.clear();
    $("#timeline").innerHTML = "";
    $("#toolkit-count").classList.add("hidden");
    await refreshRuns();
    if (token !== state.navigation) return;
    renderWorkspaces();
    renderNavigation();
    updateLocation();
    renderRun();
    renderResults();
    renderHistory();
    void refreshContext(id);
    const stream = new EventSource(`/api/runs/${id}/events`);
    state.stream = stream;
    stream.onmessage = (event) => {
      if (state.run?.id !== id || token !== state.navigation) return;
      const item = JSON.parse(event.data);
      if (item.seq <= state.lastSeq) return;
      state.lastSeq = item.seq;
      state.events.push(item);
      applyEvent(item);
    };
    stream.onopen = () => {
      $("#connection").innerHTML =
        '<span class="live-dot"></span> 执行事件已连接';
      $("#connection").classList.remove("disconnected");
    };
    stream.onerror = () => {
      $("#connection").innerHTML =
        '<span class="live-dot"></span> 正在重新连接';
      $("#connection").classList.add("disconnected");
    };
  } catch (error) {
    toast(error.message);
  } finally {
    if (token === state.navigation) state.loading = false;
  }
}
function renderRun() {
  const run = state.run;
  if (!run) return;
  renderNavigation();
  $("#short-id").textContent = "/ " + run.id.slice(0, 8);
  $("#run-title").textContent = run.title;
  $("#run-title").title = run.title;
  $("#run-repo").textContent = run.repository;
  $("#run-status").textContent = labels[run.status];
  $("#run-status").className = "status-badge " + run.status;
  for (const button of [$("#stop-button"), $("#stop-inline")]) {
    button.disabled = !active(run.status) || run.status === "stopping";
    button.textContent =
      run.status === "stopping"
        ? "正在停止…"
        : run.status === "compacting"
          ? "■ 取消压缩"
          : "■ 停止执行";
    button.title = active(run.status)
      ? "中断模型请求和当前工具，保留已有记录"
      : "当前任务已结束，没有正在执行的操作";
  }
  $("#stop-inline").classList.toggle("hidden", !active(run.status));
  $("#continue-button").classList.toggle("hidden", active(run.status));
  $("#continue-button").disabled = active(run.status);
  $("#followup").disabled = active(run.status);
  $("#continue-hint").textContent = active(run.status)
    ? run.status === "compacting"
      ? "正在生成压缩摘要，可点击停止取消"
      : "Agent 正在执行，可停止后补充指令"
    : "保留已有上下文，继续这个审计";
  $("#metric-tools").textContent = run.toolCalls;
  $("#metric-findings").textContent = state.findings.length;
  $("#metric-tokens").textContent =
    `${formatNumber(run.inputTokens)} / ${formatNumber(run.outputTokens)}`;
  $("#export-button").disabled = !state.report;
  renderContext();
  updateDuration();
}
let contextRequest;
async function refreshContext(id) {
  if (contextRequest === id) return;
  contextRequest = id;
  try {
    const data = await api(`/api/runs/${id}/context`);
    if (state.run?.id === id) {
      state.context = data;
      renderContext();
    }
  } catch (error) {
    if (state.run?.id === id) {
      state.context = null;
      renderContext();
      $("#context-detail").textContent = "上下文统计暂不可用：" + error.message;
    }
  } finally {
    if (contextRequest === id) contextRequest = null;
  }
}
function renderContext() {
  const c = state.context,
    run = state.run;
  if (!run) return;
  const capacity = c?.contextWindow || run.modelConfig.contextWindow;
  const known = typeof c?.tokens === "number";
  const compacting = run.status === "compacting" || c?.isCompacting;
  $("#context-mode").textContent = compacting
    ? "压缩进行中"
    : known
      ? "SDK 估算"
      : c?.lastCompaction
        ? "等待下轮响应校准"
        : "尚无统计";
  $("#context-used").textContent = known
    ? `${c.tokens.toLocaleString()} / ${capacity.toLocaleString()} tokens`
    : `— / ${capacity.toLocaleString()} tokens`;
  $("#context-percent").textContent =
    typeof c?.percent === "number" ? `${c.percent.toFixed(1)}%` : "未知";
  const meter = $("#context-meter");
  meter.querySelector("span").style.width =
    typeof c?.percent === "number"
      ? `${Math.max(0, Math.min(100, c.percent))}%`
      : "0%";
  meter.classList.toggle("unknown", !known);
  if (known) meter.setAttribute("aria-valuenow", String(c.percent));
  else meter.removeAttribute("aria-valuenow");
  meter.setAttribute(
    "aria-valuetext",
    known
      ? `${c.tokens} tokens，${c.percent?.toFixed(1)}%`
      : "上下文占用暂未知",
  );
  $("#context-remaining").textContent =
    typeof c?.remainingTokens === "number"
      ? `剩余约 ${c.remainingTokens.toLocaleString()} tokens`
      : "剩余空间待 SDK 校准";
  $("#context-auto").textContent = c
    ? `自动压缩：${c.autoCompactionEnabled ? "已开启" : "已关闭"}`
    : "自动压缩：读取中";
  const prior = c?.lastCompaction;
  const last = prior
    ? `最近压缩：${prior.tokensBefore.toLocaleString()} → ${typeof prior.estimatedTokensAfter === "number" ? `约 ${prior.estimatedTokensAfter.toLocaleString()}` : "未知"} tokens（压缩后为估算值）。`
    : "";
  $("#context-detail").textContent = [
    c?.compactionError || "",
    last,
    "上下文占用按 SDK 当前会话估算，窗口来自任务模型配置；与累计输入/输出 token 分开统计。",
  ]
    .filter(Boolean)
    .join(" ");
  const button = $("#compact-button");
  button.disabled = active(run.status) || !run.sessionFile;
  button.textContent = compacting ? "正在压缩…" : "压缩上下文";
  button.title = active(run.status)
    ? "等待审计结束或停止后可手动压缩"
    : !run.sessionFile
      ? "尚无可压缩会话"
      : "调用当前模型生成上下文摘要，原始历史和审计产物保留";
}
$("#compact-button").addEventListener("click", async () => {
  const id = state.run?.id;
  if (!id || active(state.run.status)) return;
  busy($("#compact-button"), true);
  try {
    const run = await api(`/api/runs/${id}/compact`, {});
    if (state.run?.id === id) {
      state.run = run;
      renderRun();
    }
    void refreshContext(id);
  } catch (error) {
    toast(error.message);
    void syncRun();
  }
});
function updateDuration() {
  if (!state.run?.startedAt) return;
  const ms = Math.max(
    0,
    new Date(state.run.endedAt || Date.now()) - new Date(state.run.startedAt),
  );
  $("#metric-time").textContent =
    ms < 60000
      ? `${Math.floor(ms / 1000)}s`
      : `${Math.floor(ms / 60000)}m ${Math.floor(ms / 1000) % 60}s`;
}
setInterval(updateDuration, 1000);
function traceItem(kind, title, timestamp) {
  const node = document.createElement("article");
  node.className = "trace-item " + kind;
  node.innerHTML = `<div class="trace-label"><strong>${escape(title)}</strong><time>${time(timestamp)}</time></div><div class="trace-body"></div>`;
  $("#timeline").append(node);
  return node;
}
function bottom() {
  $("#timeline").scrollTop = $("#timeline").scrollHeight;
}
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    for (const item of state.nodes.values())
      if (item.kind === "assistant" && item.dirty) {
        renderAssistant(item);
        item.dirty = false;
      }
  }, 80);
}
function renderAssistant(item) {
  const wasNearBottom =
    $("#timeline").scrollHeight -
      $("#timeline").scrollTop -
      $("#timeline").clientHeight <
    150;
  item.node.querySelector(".trace-body").innerHTML =
    `${item.thinking ? `<details class="thinking-block"><summary>模型思考</summary><pre>${escape(item.thinking)}</pre></details>` : ""}<div class="markdown">${markdown(item.text)}</div>`;
  if (wasNearBottom) bottom();
}
function applyEvent(event) {
  const d = event.data;
  const nearBottom =
    $("#timeline").scrollHeight -
      $("#timeline").scrollTop -
      $("#timeline").clientHeight <
    150;
  switch (event.type) {
    case "user_message":
      traceItem("user", "审计指令", event.at).querySelector(
        ".trace-body",
      ).textContent = d.text;
      break;
    case "repository":
      break;
    case "status":
      if (Array.isArray(d.tools)) {
        $("#toolkit-count").textContent = `${d.tools.length} tools`;
        $("#toolkit-count").title = d.tools.join(" · ");
        $("#toolkit-count").classList.remove("hidden");
      }
      // On initial history replay use the REST snapshot; older status events must not move a completed run backwards.
      if (event.seq > 0) {
        void syncRun();
      }
      if (d.message)
        traceItem("system", "会话状态", event.at).querySelector(
          ".trace-body",
        ).textContent = d.message;
      break;
    case "assistant_start": {
      const node = traceItem("assistant", "Agent", event.at);
      state.nodes.set(d.messageId, {
        kind: "assistant",
        node,
        text: "",
        thinking: "",
      });
      break;
    }
    case "assistant_delta": {
      const item = state.nodes.get(d.messageId);
      if (!item) break;
      item[d.channel] += d.delta;
      item.dirty = true;
      scheduleRender();
      break;
    }
    case "assistant_end": {
      const item = state.nodes.get(d.messageId);
      if (item) {
        item.text = d.text;
        item.thinking = d.thinking;
        renderAssistant(item);
        item.dirty = false;
      }
      if (d.stopReason === "stop" && d.text) {
        state.report = d.text;
        renderResults();
      }
      void syncRun();
      break;
    }
    case "tool_start": {
      const node = traceItem("tool", "工具调用", event.at);
      const args = JSON.stringify(d.args, null, 2);
      node.querySelector(".trace-body").innerHTML =
        `<details class="tool-card running"><summary><span>${escape(d.name)}</span><span class="tool-state">执行中…</span></summary><div class="tool-arguments">${escape(args)}</div><pre class="tool-output">等待工具返回…</pre></details>`;
      state.nodes.set(d.toolCallId, { kind: "tool", node });
      void syncRun();
      break;
    }
    case "tool_update":
    case "tool_end": {
      const item = state.nodes.get(d.toolCallId);
      if (!item) break;
      const details = item.node.querySelector(".tool-card");
      item.node.querySelector(".tool-output").textContent = textOf(d.result);
      if (event.type === "tool_end") {
        const outcome = d.result?.details;
        const label = outcome?.errors?.length
          ? "部分来源失败"
          : outcome?.patchCaptureComplete === false
            ? "补丁获取失败"
            : outcome?.timedOut
              ? "超时"
              : outcome?.aborted
                ? "已取消"
                : typeof outcome?.exitCode === "number" &&
                    outcome.exitCode !== 0
                  ? `退出 ${outcome.exitCode}`
                  : d.isError
                    ? "失败"
                    : "完成";
        details.classList.remove("running");
        details.classList.toggle(
          "failed",
          Boolean(d.isError) || label !== "完成",
        );
        details.querySelector(".tool-state").textContent =
          `${label}${typeof d.durationMs === "number" ? " · " + (d.durationMs / 1000).toFixed(1) + "s" : ""}`;
        const artifact = d.result?.details?.artifact;
        if (artifact) {
          const link = document.createElement("a");
          link.className = "artifact-link";
          link.textContent = artifact.endsWith(".patch")
            ? d.result?.details?.complete === false
              ? "↗ 查看部分补丁（捕获截断）"
              : "↗ 查看完整补丁"
            : artifact.endsWith(".json")
              ? "↗ 查看完整记录"
              : "↗ 查看完整实验输出";
          link.target = "_blank";
          link.rel = "noopener";
          link.href = `/api/runs/${state.run.id}/artifacts/${encodeURIComponent(artifact)}`;
          details.append(link);
        }
        const evidence = d.result?.details;
        if (evidence?.viewerUrl) {
          const url = new URL(evidence.viewerUrl, location.href);
          if (
            url.origin === location.origin &&
            url.pathname === "/graph.html"
          ) {
            const link = document.createElement("a");
            link.className = "artifact-link";
            link.textContent = "↗ 打开调用图";
            link.href = url.href;
            link.target = "_blank";
            link.rel = "noopener";
            details.append(link);
          }
        }
        if (evidence?.patchArtifact) {
          const link = document.createElement("a");
          link.className = "artifact-link";
          link.textContent = "↗ 查看在线补丁";
          link.href = `/api/runs/${state.run.id}/artifacts/${encodeURIComponent(evidence.patchArtifact)}`;
          link.target = "_blank";
          link.rel = "noopener";
          details.append(link);
        }
        const sources = [
          ...(evidence?.sources || []),
          ...(evidence?.relatedFixes || []),
          ...(evidence?.url ? [{ url: evidence.url, title: "原始来源" }] : []),
        ];
        const seen = new Set();
        for (const source of sources.slice(0, 20)) {
          try {
            const url = new URL(source.url);
            if (url.protocol !== "https:" || seen.has(url.href)) continue;
            seen.add(url.href);
            const link = document.createElement("a");
            link.className = "artifact-link source-link";
            link.textContent =
              "↗ " + (source.title || source.url).slice(0, 100);
            link.href = url.href;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            details.append(link);
          } catch {}
        }
      }
      break;
    }
    case "finding": {
      const index = state.findings.findIndex((f) => f.id === d.finding.id);
      if (index >= 0) state.findings[index] = d.finding;
      else state.findings.push(d.finding);
      renderResults();
      renderRun();
      break;
    }
    case "notes":
      state.notes = d.text;
      if (state.page === "notes") renderResults();
      break;
    case "error":
      traceItem("error", "执行遇到问题", event.at).querySelector(
        ".trace-body",
      ).textContent = d.message;
      break;
    case "system":
      if (
        d.type === "compaction_start" ||
        d.type === "compaction_end" ||
        d.type === "manual_compaction_notice"
      )
        void syncRun();
      traceItem("system", "运行时", event.at).querySelector(
        ".trace-body",
      ).textContent =
        {
          compaction_start:
            d.reason === "manual"
              ? "正在手动压缩上下文…"
              : "正在自动压缩上下文…",
          compaction_end: d.aborted
            ? "上下文压缩已取消"
            : d.errorMessage ||
              (d.result
                ? `上下文压缩完成：${formatNumber(d.result.tokensBefore)} → ${typeof d.result.estimatedTokensAfter === "number" ? `约 ${formatNumber(d.result.estimatedTokensAfter)}` : "未知"} tokens（摘要估算）`
                : "上下文压缩未完成"),
          manual_compaction_notice: d.message,
          auto_retry_start: `模型请求重试 ${d.attempt || ""}：${d.errorMessage || ""}`,
          auto_retry_end: d.success ? "请求重试成功" : "重试结束",
        }[d.type] || d.type;
      break;
  }
  if (nearBottom && event.type !== "assistant_delta") bottom();
}
let syncTimer;
async function syncRun() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    const id = state.run?.id;
    if (!id) return;
    try {
      const data = await api("/api/runs/" + id);
      if (state.run?.id !== id) return;
      state.run = data.run;
      state.findings = data.findings;
      state.notes = data.notes;
      state.report = data.report;
      renderRun();
      renderResults();
      void refreshContext(id);
      await refreshRuns();
    } catch (error) {
      toast(error.message);
    }
  }, 120);
}
function renderResults() {
  $("#finding-count").textContent = state.findings.length;
  $("#findings-panel").innerHTML = state.findings.length
    ? state.findings
        .map(
          (f) =>
            `<article class="finding-card"><div class="finding-top"><span class="severity ${escape(f.severity.toLowerCase())}">${escape(f.severity.toUpperCase())}</span><span class="finding-id">${escape(f.id)}</span><span class="finding-status">${escape(f.status)}</span></div><h3>${escape(f.title)}</h3>${f.location ? `<code class="finding-location">${escape(f.location)}</code>` : ""}<p>${escape(f.description)}</p><details><summary>查看详细说明与证据</summary><div class="markdown">${markdown(f.description)}</div>${[
              ["前置条件", f.preconditions],
              ["证据", f.evidence],
              ["复现", f.reproduction],
              ["修复建议", f.recommendation],
            ]
              .filter(([, value]) => value)
              .map(
                ([label, value]) =>
                  `<h4>${label}</h4><div class="markdown">${markdown(value)}</div>`,
              )
              .join("")}</details></article>`,
        )
        .join("")
    : empty(
        "等待值得记录的发现",
        "Agent 会在阅读与验证后记录候选和结论；没有发现时也会如实说明。",
      );
  $("#report-panel").innerHTML = state.report
    ? markdown(state.report)
    : empty(
        "报告尚未生成",
        "本轮审计完成后，这里会展示 Agent 的实际结论。",
        "≡",
      );
  $("#notes-panel").innerHTML = state.notes
    ? markdown(state.notes)
    : empty(
        "审计记忆留在这里",
        "重要线索、排除的假设和下一步，由 Agent 按需写入。",
        "⌁",
      );
}
$("#continue-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = $("#followup").value.trim();
  if (!message || !state.run) return;
  busy($("#continue-button"), true);
  try {
    state.run = await api(`/api/runs/${state.run.id}/continue`, { message });
    $("#followup").value = "";
    renderRun();
  } catch (error) {
    toast(error.message);
    busy($("#continue-button"), false);
  }
});
async function stopRun() {
  const id = state.run?.id;
  if (!id || !active(state.run.status) || state.run.status === "stopping")
    return;
  state.run.status = "stopping";
  renderRun();
  try {
    const run = await api(`/api/runs/${id}/stop`, {});
    if (state.run?.id === id) {
      state.run = run;
      renderRun();
    }
    await refreshRuns();
  } catch (error) {
    toast(error.message);
    await refreshRuns().catch(() => {});
  }
}
$("#stop-button").addEventListener("click", stopRun);
$("#stop-inline").addEventListener("click", stopRun);
$("#export-button").addEventListener("click", () => {
  window.location.href = `/api/runs/${state.run.id}/report`;
});
$("#scroll-bottom").addEventListener("click", bottom);
$("#run-list").addEventListener("click", (event) => {
  const id = event.target.closest("[data-run]")?.dataset.run;
  if (id) void openRun(id);
});
$("#new-run").addEventListener("click", showNew);
$(".brand").addEventListener("click", (event) => {
  event.preventDefault();
  showNew();
});
document.querySelectorAll("[data-prompt]").forEach((button) =>
  button.addEventListener("click", () => {
    $("#goal").value = button.dataset.prompt;
    $("#goal").focus();
  }),
);

function openSettings() {
  const c = state.config;
  if (!c) return;
  $("#provider").value = c.provider === "deepseek" ? "deepseek" : "custom";
  $("#model").value = c.model;
  $("#api").value = c.api;
  $("#base-url").value = c.baseUrl;
  $("#api-key").value = "";
  $("#context-window").value = c.contextWindow;
  $("#max-tokens").value = c.maxTokens;
  $("#api-key").placeholder = c.hasApiKey ? "已配置 · 留空保留" : "sk-…";
  $("#credential-source").textContent = `凭据来源：${c.credentialSource}`;
  $("#config-result").classList.add("hidden");
  $("#settings-modal").showModal();
  void api("/api/models")
    .then((data) => {
      $("#model-options").innerHTML = data.models
        .map((m) => `<option value="${escape(m.id)}"></option>`)
        .join("");
    })
    .catch(() => {});
}
const configInput = () => ({
  provider: $("#provider").value,
  model: $("#model").value.trim(),
  api: $("#api").value,
  baseUrl: $("#base-url").value.trim(),
  apiKey: $("#api-key").value,
  contextWindow: Number($("#context-window").value),
  maxTokens: Number($("#max-tokens").value),
});
$("#settings-button").addEventListener("click", openSettings);
$("#settings-side").addEventListener("click", openSettings);
$("#provider").addEventListener("change", () => {
  if ($("#provider").value === "deepseek") {
    $("#base-url").value = "https://api.deepseek.com/v1";
    $("#model").value = "deepseek-flash";
    $("#api").value = "openai-completions";
  }
});
$("#config-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/config", configInput());
    await loadConfig();
    $("#settings-modal").close();
    toast("模型配置已保存到本机");
  } catch (error) {
    toast(error.message);
  }
});
$("#test-connection").addEventListener("click", async () => {
  const button = $("#test-connection");
  busy(button, true, "正在调用真实模型…");
  const result = $("#config-result");
  result.className = "config-result";
  result.textContent = "等待供应商响应…";
  try {
    const data = await api("/api/config/test", configInput());
    result.textContent = `${data.reply || "连接成功"} · ${data.model} · ${(data.latencyMs / 1000).toFixed(2)}s`;
  } catch (error) {
    result.classList.add("error");
    result.textContent = error.message;
  } finally {
    busy(button, false, "测试真实连接");
  }
});
document
  .querySelectorAll(".close-modal")
  .forEach((button) =>
    button.addEventListener("click", () => button.closest("dialog").close()),
  );
document.querySelectorAll("dialog").forEach((dialog) =>
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      const r = dialog.getBoundingClientRect();
      if (
        event.clientX < r.left ||
        event.clientX > r.right ||
        event.clientY < r.top ||
        event.clientY > r.bottom
      )
        dialog.close();
    }
  }),
);

async function browse(path) {
  try {
    const data = await api("/api/directories?path=" + encodeURIComponent(path));
    state.browsing = data;
    $("#browse-path").value = data.path;
    $("#directory-list").innerHTML = data.directories.length
      ? data.directories
          .map(
            (d) =>
              `<button class="directory-item" data-directory="${escape(d.path)}"><span>▱</span>${escape(d.name)}${d.isGit ? "<small>GIT REPOSITORY</small>" : ""}</button>`,
          )
          .join("")
      : '<div class="history-empty">当前目录没有子文件夹，可以直接选择此目录。</div>';
  } catch (error) {
    toast(error.message);
  }
}
$("#browse-button").addEventListener("click", openWorkspaces);
$("#workspace-browse").addEventListener("click", () => {
  $("#browse-modal").showModal();
  void browse(
    $("#workspace-repository").value || state.config.defaultRepository,
  );
});
$("#directory-list").addEventListener("click", (event) => {
  const node = event.target.closest("[data-directory]");
  if (!node) return;
  for (const item of document.querySelectorAll(".directory-item"))
    item.classList.remove("selected");
  node.classList.add("selected");
});
$("#directory-list").addEventListener("dblclick", (event) => {
  const path = event.target.closest("[data-directory]")?.dataset.directory;
  if (path) void browse(path);
});
$("#parent-directory").addEventListener("click", () => {
  if (state.browsing) void browse(state.browsing.parent);
});
$("#go-directory").addEventListener(
  "click",
  () => void browse($("#browse-path").value),
);
$("#browse-path").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void browse(event.target.value);
  }
});
$("#select-directory").addEventListener("click", () => {
  if (!state.browsing) return;
  $("#workspace-repository").value =
    $(".directory-item.selected")?.dataset.directory || state.browsing.path;
  $("#browse-modal").close();
});
document.addEventListener("keydown", (event) => {
  if (
    event.key.toLowerCase() === "n" &&
    !["INPUT", "TEXTAREA", "SELECT"].includes(
      document.activeElement?.tagName,
    ) &&
    !document.querySelector("dialog[open]") &&
    !event.metaKey &&
    !event.ctrlKey
  )
    showNew();
});

try {
  await loadConfig();
  state.workspaces = await api("/api/workspaces");
  const params = new URLSearchParams(location.search);
  state.page = pages[params.get("view")] ? params.get("view") : "trace";
  renderWorkspaces();
  if (params.get("run")) await openRun(params.get("run"), state.page);
  else {
    const workspace =
      state.workspaces.find(
        (w) =>
          w.id === (params.get("workspace") || preference.get("workspace")),
      ) || state.workspaces[0];
    if (workspace)
      await selectWorkspace(workspace.id, {
        newAudit: params.get("view") === "new",
      });
    else showNew();
  }
} catch (error) {
  $("#connection").innerHTML = '<span class="live-dot"></span> 工作台加载失败';
  $("#connection").classList.add("disconnected");
  toast(error.message);
}
