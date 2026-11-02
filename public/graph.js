const $ = (s) => document.querySelector(s),
  params = new URLSearchParams(location.search),
  run = params.get("run"),
  artifact = params.get("artifact");
const svg = $("#graph"),
  ns = "http://www.w3.org/2000/svg";
let data, selected;
const make = (tag, attrs = {}, text) => {
  const e = document.createElementNS(ns, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
};
const item = (parent, text) => {
  const e = document.createElement("div");
  e.className = "item";
  e.textContent = text;
  parent.append(e);
};
function detail(node) {
  selected = node.id;
  $("#detail").replaceChildren();
  item(
    $("#detail"),
    node.qualifiedName +
      "\n" +
      node.path +
      ":" +
      (node.nameLine || node.startLine || 1),
  );
  for (const edge of data.edges.filter(
    (e) => e.from === node.id || e.to === node.id,
  )) {
    const incoming = edge.to === node.id;
    const other = data.nodes.find(
      (n) => n.id === (incoming ? edge.from : edge.to),
    );
    item(
      $("#detail"),
      (incoming ? "← 来自 " : "→ 调用 ") +
        (other?.qualifiedName || "?") +
        "\n" +
        edge.path +
        ":" +
        edge.line +
        ":" +
        edge.column +
        (edge.ambiguous ? "（多个可能定义）" : ""),
    );
  }
  for (const call of data.unresolved.filter((c) => c.from === node.id))
    item(
      $("#detail"),
      "未解析：" +
        call.text +
        " · " +
        call.reason +
        "\n" +
        call.path +
        ":" +
        call.line,
    );
  for (const e of svg.querySelectorAll("[data-node]"))
    e.classList.toggle("active", e.dataset.node === node.id);
  for (const e of svg.querySelectorAll("[data-from]"))
    e.classList.toggle(
      "focus",
      e.dataset.from === node.id || e.dataset.to === node.id,
    );
}
function render() {
  const q = $("#search").value.trim().toLowerCase();
  const ids = new Set(
    data.nodes
      .filter(
        (n) => !q || (n.qualifiedName + " " + n.path).toLowerCase().includes(q),
      )
      .map((n) => n.id),
  );
  if (q) {
    let changed = true;
    while (changed) {
      changed = false;
      const frontier = new Set(ids);
      for (const edge of data.edges)
        if (frontier.has(edge.from) || frontier.has(edge.to)) {
          for (const id of [edge.from, edge.to])
            if (!ids.has(id)) {
              ids.add(id);
              changed = true;
            }
        }
      if (!$("#transitive").checked) break;
    }
  }
  const nodes = data.nodes.filter((n) => ids.has(n.id)),
    edges = data.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  $("#count").textContent =
    `显示 ${nodes.length} / ${data.nodes.length} 节点 · ${edges.length} 条边`;
  svg.replaceChildren();
  const defs = make("defs"),
    marker = make("marker", {
      id: "arrow",
      markerWidth: 6,
      markerHeight: 6,
      refX: 6,
      refY: 3,
      orient: "auto",
    });
  marker.append(make("path", { d: "M0,0 L6,3 L0,6 z", fill: "#739480" }));
  defs.append(marker);
  svg.append(defs);
  const groups = new Map();
  for (const node of nodes) {
    const group = groups.get(node.path) || [];
    group.push(node);
    groups.set(node.path, group);
  }
  const positions = new Map();
  const heights = [30, 30, 30];
  let groupIndex = 0;
  const labels = [];
  for (const [path, list] of groups) {
    const col = groupIndex++ % 3,
      x = col * 360 + 20;
    let y = heights[col];
    labels.push({ x, y, path: path.replace(data.repository + "/", "") });
    y += 22;
    for (const node of list) {
      positions.set(node.id, { x, y });
      y += 46;
    }
    heights[col] = y + 35;
  }
  svg.setAttribute("width", 1080);
  svg.setAttribute("height", Math.max(500, ...heights));
  for (const edge of edges) {
    const a = positions.get(edge.from),
      b = positions.get(edge.to);
    if (!a || !b) continue;
    const path = make("path", {
      class: "edge",
      d: `M${a.x + 295},${a.y + 15} C${a.x + 335},${a.y + 15} ${b.x - 30},${b.y + 15} ${b.x},${b.y + 15}`,
      "marker-end": "url(#arrow)",
      "data-from": edge.from,
      "data-to": edge.to,
    });
    const title = make("title", {}, `${edge.path}:${edge.line}:${edge.column}`);
    path.append(title);
    svg.append(path);
  }
  for (const label of labels) {
    const text = make(
      "text",
      { x: label.x, y: label.y, class: "file" },
      label.path.length > 48 ? "…" + label.path.slice(-47) : label.path,
    );
    text.append(make("title", {}, label.path));
    svg.append(text);
  }
  for (const node of nodes) {
    const { x, y } = positions.get(node.id),
      group = make("g", {
        class: "node" + (node.external ? " external" : ""),
        transform: `translate(${x},${y})`,
        "data-node": node.id,
        tabindex: 0,
        role: "button",
        "aria-label": node.qualifiedName,
      });
    group.append(
      make("rect", { width: 295, height: 31, rx: 5 }),
      make(
        "text",
        { x: 9, y: 20 },
        node.qualifiedName.length > 37
          ? node.qualifiedName.slice(0, 36) + "…"
          : node.qualifiedName,
      ),
      make(
        "title",
        {},
        node.qualifiedName + "\n" + node.path + ":" + (node.nameLine || 1),
      ),
    );
    group.addEventListener("click", () => detail(node));
    group.addEventListener("keydown", (e) => {
      if (e.key === "Enter") detail(node);
    });
    svg.append(group);
  }
}
try {
  if (!run || !artifact) throw Error("请从审计工具卡片打开调用图");
  $("#back").href = "/?run=" + encodeURIComponent(run) + "&view=trace";
  const url = `/api/runs/${encodeURIComponent(run)}/artifacts/${encodeURIComponent(artifact)}`;
  $("#download").href = url;
  const response = await fetch(url);
  if (!response.ok) throw Error("调用图读取失败");
  data = await response.json();
  if (data.schema !== 1 || !data.nodes || !data.edges)
    throw Error("不是支持的调用图产物");
  $("#summary").textContent =
    data.scope + " · " + new Date(data.generatedAt).toLocaleString();
  $("#coverage").textContent =
    `实际分析 ${data.coverage.indexedFiles} 个文件，${data.coverage.callSites} 个调用点，${data.unresolved.length} 个未解析。静态范围分析${data.coverage.staticAnalysisComplete ? "已完成" : "存在边界/遗漏"}；动态分派、反射与运行环境可能增加调用。图是生成时的源码快照。`;
  for (const value of [...data.errors, ...data.excluded, ...data.unresolved])
    item($("#limitations"), JSON.stringify(value, null, 2));
  if (!$("#limitations").children.length)
    item(
      $("#limitations"),
      "该静态范围未发现分析缺口，仍不等于完整运行时路径。",
    );
  render();
  $("#search").addEventListener("input", render);
  $("#transitive").addEventListener("change", render);
  $("#reset").addEventListener("click", () => {
    $("#search").value = "";
    render();
  });
} catch (error) {
  $("#summary").textContent = error.message;
  $("#summary").classList.add("error");
}
