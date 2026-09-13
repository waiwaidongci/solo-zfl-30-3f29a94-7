/* 水下考古潜水记录 —— 页面层
 * 只负责渲染与交互；所有数据规则（流转、校验、审计、撤销）都在 js/store.js。
 */
(function () {
  "use strict";

  const { createStore, migrate, localStorageAdapter, STATUS, EVIDENCE_FIELDS, TRANSITIONS } = window.MarkStore;

  const STORAGE_KEY = "zfl30Marks";
  const OPERATOR_KEY = "zfl30Operator";
  const adapter = localStorageAdapter(STORAGE_KEY);

  // 首次使用写入示例数据（旧用户的 v0 数组由 store 内 migrate 自动升级）
  if (adapter.load() === null) {
    adapter.save(migrate([
      { id: "seed-a017", code: "A-017", type: "ceramic", dive: "DIVE-01", x: 42, y: 46, depth: 17.8, orientation: "东", condition: "边缘残缺", note: "靠近船肋" },
      { id: "seed-w003", code: "W-003", type: "wood", dive: "DIVE-02", x: 58, y: 39, depth: 18.2, orientation: "西北", condition: "稳定", note: "疑似横梁",
        evidence: { bagNo: "BAG-07", photoDesc: "全景1张+特写2张", handler: "李四", storage: "冷藏柜A-01" } },
    ]));
  }
  const store = createStore({ storage: adapter });

  const $ = (sel) => document.querySelector(sel);
  const map = $("#map");
  const form = $("#form");
  const F = (name) => form.elements.namedItem(name);
  const list = $("#list");
  const listTitle = $("#listTitle");
  const filterType = $("#filterType");
  const filterStatus = $("#filterStatus");
  const view = $("#view");
  const msg = $("#msg");
  const operatorEl = $("#operator");
  const reasonEl = $("#reasonInput");
  const fieldsEl = $("#fields");
  const statusLine = $("#statusLine");
  const statusPill = $("#statusPill");
  const statusHint = $("#statusHint");
  const returnNote = $("#returnNote");
  const transitionBar = $("#transitionBar");
  const saveBtn = $("#saveBtn");
  const deleteBtn = $("#deleteBtn");
  const undoBtn = $("#undoBtn");
  const redoBtn = $("#redoBtn");
  const batchBar = $("#batchBar");
  const batchHint = $("#batchHint");
  const checkAll = $("#checkAll");

  const typeNames = { ceramic: "陶片", wood: "木构件", metal: "金属件", unknown: "未知物" };
  const FIELD_LABELS = {
    code: "编号", type: "类型", dive: "潜次", x: "坐标X", y: "坐标Y", depth: "深度",
    orientation: "朝向", condition: "保存状态", note: "备注", status: "状态", returnReason: "退回原因",
  };
  EVIDENCE_FIELDS.forEach(([k, label]) => { FIELD_LABELS["evidence." + k] = label; });

  let editingId = null;          // 当前表单编辑的标记 id，null 表示新增
  const selectedIds = new Set(); // 批量操作勾选

  operatorEl.value = localStorage.getItem(OPERATOR_KEY) || "";
  operatorEl.addEventListener("input", () => localStorage.setItem(OPERATOR_KEY, operatorEl.value.trim()));

  $("#maxDepthLabel").textContent = store.getState().limits.maxDepth;

  // 沉船肋条
  for (let i = 0; i < 7; i++) {
    const rib = document.createElement("div");
    rib.className = "rib";
    rib.style.left = 28 + i * 7 + "%";
    map.appendChild(rib);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function ctx() {
    return { operator: operatorEl.value.trim(), reason: reasonEl.value.trim() };
  }

  function showError(issues) {
    msg.className = "msg error";
    msg.hidden = false;
    msg.innerHTML = "<b>已拦截，未保存任何变更：</b><ul>" +
      issues.map((i) => "<li>" + esc(i.message) + "</li>").join("") + "</ul>";
  }

  function showOk(text) {
    msg.className = "msg ok";
    msg.hidden = false;
    msg.textContent = text;
  }

  function clearMsg() {
    msg.hidden = true;
    msg.textContent = "";
  }

  function filteredMarks(marks) {
    return marks.filter((m) =>
      (!filterType.value || m.type === filterType.value) &&
      (!filterStatus.value || m.status === filterStatus.value));
  }

  function statusPillHtml(m) {
    return '<span class="pill ' + m.status + '">' + STATUS[m.status] + "</span>";
  }

  function evidenceBadges(m) {
    const missing = EVIDENCE_FIELDS.filter(([k]) => !String(m.evidence[k] || "").trim());
    return missing.length
      ? '<span class="muted">缺证据：' + missing.map(([, l]) => l).join("、") + "</span>"
      : '<span class="muted">证据齐全</span>';
  }

  // ---- 渲染 ----

  function render(state) {
    renderMarkers(state.marks);
    const data = filteredMarks(state.marks);
    if (view.value === "timeline") renderTimeline(data);
    else if (view.value === "audit") renderAudit(state.audit);
    else renderList(data);
    renderForm(state);
    undoBtn.disabled = !state.canUndo;
    redoBtn.disabled = !state.canRedo;
    undoBtn.title = state.undoLabel || "";
    redoBtn.title = state.redoLabel || "";
    batchBar.style.display = view.value === "list" ? "" : "none";
    batchHint.textContent = selectedIds.size ? "已选 " + selectedIds.size + " 项" : "";
  }

  function renderMarkers(marks) {
    map.querySelectorAll(".marker").forEach((el) => el.remove());
    filteredMarks(marks).forEach((mark) => {
      if (!Number.isFinite(mark.x) || !Number.isFinite(mark.y)) return;
      const el = document.createElement("button");
      el.type = "button";
      el.className = "marker " + mark.type + " st-" + mark.status + (mark.id === editingId ? " selected" : "");
      el.style.left = mark.x + "%";
      el.style.top = mark.y + "%";
      el.textContent = mark.code.slice(0, 2);
      el.title = mark.code + " · " + STATUS[mark.status];
      el.onclick = (event) => { event.stopPropagation(); edit(mark.id); };
      map.appendChild(el);
    });
  }

  function renderList(data) {
    listTitle.textContent = "标记列表（" + data.length + "）";
    list.className = "list";
    list.innerHTML = data.map((m) =>
      '<div class="item ' + (m.id === editingId ? "active" : "") + '" data-id="' + m.id + '">' +
        '<div class="row">' +
          '<input type="checkbox" data-check="' + m.id + '"' + (selectedIds.has(m.id) ? " checked" : "") + ">" +
          "<b>" + esc(m.code) + "</b>" + statusPillHtml(m) +
          '<span class="pill type">' + typeNames[m.type] + "</span>" +
        "</div>" +
        '<div class="muted">' + esc(m.dive) + " · " + m.depth + "m · " + esc(m.orientation) + "</div>" +
        "<div>" + esc(m.condition) + "</div>" +
        "<div>" + evidenceBadges(m) + (m.evidence.storage ? ' · <span class="muted">保管：' + esc(m.evidence.storage) + "</span>" : "") + "</div>" +
      "</div>").join("");
    list.querySelectorAll("[data-id]").forEach((el) => {
      el.addEventListener("click", (e) => {
        if (e.target.matches("input[type=checkbox]")) return;
        edit(el.dataset.id);
      });
    });
    list.querySelectorAll("[data-check]").forEach((cb) => {
      cb.addEventListener("change", () => {
        if (cb.checked) selectedIds.add(cb.dataset.check);
        else selectedIds.delete(cb.dataset.check);
        render(store.getState());
      });
    });
  }

  function renderTimeline(data) {
    listTitle.textContent = "潜次时间线";
    list.className = "timeline";
    const groups = data.reduce((acc, item) => { (acc[item.dive] = acc[item.dive] || []).push(item); return acc; }, {});
    list.innerHTML = Object.entries(groups).map(([dive, items]) =>
      '<div class="item"><b>' + esc(dive) + '</b><div class="muted">' + items.length + " 个标记</div>" +
      items.map((i) => "<div>" + esc(i.code) + " · " + typeNames[i.type] + " · " + STATUS[i.status] + "</div>").join("") +
      "</div>").join("");
  }

  function fmtValue(field, v) {
    if (field === "status") return STATUS[v] || v;
    if (v === "" || v == null) return "（空）";
    return String(v);
  }

  function renderAudit(audit) {
    listTitle.textContent = "变更记录（" + audit.length + "）";
    list.className = "audit";
    list.innerHTML = audit.slice().reverse().map((e) => {
      const time = new Date(e.ts);
      const timeText = isNaN(time) ? e.ts : time.toLocaleString("zh-CN", { hour12: false });
      const head = "<b>#" + e.seq + "</b> " + timeText + " · " + esc(e.operator) + " · " + esc(e.label) +
        (e.reason ? '<div class="muted">原因：' + esc(e.reason) + "</div>" : "");
      const diffs = (e.changes || []).map((c) => {
        if (c.kind === "create") return '<div class="diff">＋ 新建 ' + esc(c.code) + "</div>";
        if (c.kind === "delete") return '<div class="diff">－ 删除 ' + esc(c.code) + "</div>";
        return c.fields.map((f) =>
          '<div class="diff">' + esc(c.code) + " · " + (FIELD_LABELS[f.field] || f.field) + "：" +
          esc(fmtValue(f.field, f.before)) + " → " + esc(fmtValue(f.field, f.after)) + "</div>").join("");
      }).join("");
      return '<div class="entry">' + head + diffs + "</div>";
    }).join("");
  }

  function renderForm(state) {
    const mark = editingId ? state.marks.find((m) => m.id === editingId) : null;
    if (editingId && !mark) editingId = null; // 记录已被删除/撤销
    const archived = mark && mark.status === "archived";
    fieldsEl.disabled = !!archived;
    saveBtn.hidden = !!archived;
    deleteBtn.hidden = !!archived;
    statusLine.hidden = !mark;
    if (mark) {
      statusPill.className = "pill " + mark.status;
      statusPill.textContent = STATUS[mark.status];
      statusHint.textContent = "更新于 " + (mark.updatedAt ? new Date(mark.updatedAt).toLocaleString("zh-CN", { hour12: false }) : "—");
    }
    returnNote.hidden = !(mark && mark.status === "returned");
    if (mark && mark.status === "returned") {
      returnNote.textContent = "退回原因：" + (mark.returnReason || "（未填写）") + " —— 请补充证据后重新提交复核。";
    }
    // 按状态给出流转按钮
    transitionBar.innerHTML = "";
    if (mark && !archived) {
      const actions = { collected: ["submitReview"], review: ["approve", "sendBack"], returned: ["resubmit"] }[mark.status] || [];
      actions.forEach((action) => {
        const t = TRANSITIONS[action];
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = t.label;
        if (action === "approve") btn.className = "ok";
        if (action === "sendBack") btn.className = "warn";
        btn.onclick = () => doTransition(mark.id, action);
        transitionBar.appendChild(btn);
      });
    }
    if (archived) {
      const span = document.createElement("span");
      span.className = "muted";
      span.textContent = "已入库，只读。如需改动请先撤销入库。";
      transitionBar.appendChild(span);
    }
  }

  // ---- 表单 ----

  function fillForm(mark) {
    F("code").value = mark.code;
    F("type").value = mark.type;
    F("dive").value = mark.dive;
    F("depth").value = Number.isFinite(mark.depth) ? mark.depth : "";
    F("x").value = Number.isFinite(mark.x) ? mark.x : "";
    F("y").value = Number.isFinite(mark.y) ? mark.y : "";
    F("orientation").value = mark.orientation;
    F("condition").value = mark.condition;
    F("note").value = mark.note;
    F("bagNo").value = mark.evidence.bagNo;
    F("photoDesc").value = mark.evidence.photoDesc;
    F("handler").value = mark.evidence.handler;
    F("storage").value = mark.evidence.storage;
  }

  function edit(id) {
    const mark = store.getState().marks.find((m) => m.id === id);
    if (!mark) return;
    editingId = id;
    fillForm(mark);
    clearMsg();
    render(store.getState());
  }

  function resetForm(keepDive) {
    const dive = F("dive").value;
    form.reset();
    editingId = null;
    if (keepDive) F("dive").value = dive || "DIVE-01";
    clearMsg();
    render(store.getState());
  }

  function suggestCode(marks) {
    let n = marks.length + 1;
    let code;
    do { code = "M-" + String(n++).padStart(3, "0"); } while (marks.some((m) => m.code === code));
    return code;
  }

  map.addEventListener("click", (event) => {
    const rect = map.getBoundingClientRect();
    const x = Number(((event.clientX - rect.left) / rect.width * 100).toFixed(2));
    const y = Number(((event.clientY - rect.top) / rect.height * 100).toFixed(2));
    const marks = store.getState().marks;
    resetForm(true);
    F("code").value = suggestCode(marks);
    F("x").value = x;
    F("y").value = y;
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    clearMsg();
    const data = {
      code: F("code").value.trim(),
      type: F("type").value,
      dive: F("dive").value.trim(),
      depth: F("depth").value,
      x: F("x").value,
      y: F("y").value,
      orientation: F("orientation").value.trim(),
      condition: F("condition").value.trim(),
      note: F("note").value.trim(),
      evidence: {
        bagNo: F("bagNo").value.trim(),
        photoDesc: F("photoDesc").value.trim(),
        handler: F("handler").value.trim(),
        storage: F("storage").value.trim(),
      },
    };
    const result = editingId ? store.updateMark(editingId, data, ctx()) : store.addMark(data, ctx());
    if (!result.ok) { showError(result.issues); return; }
    reasonEl.value = "";
    showOk(editingId ? "已保存修改。" : "已新增标记 " + result.mark.code + "。");
    if (!editingId) {
      const dive = data.dive;
      form.reset();
      F("dive").value = dive;
      F("code").value = suggestCode(store.getState().marks);
    }
    render(store.getState());
  });

  function doTransition(id, action) {
    clearMsg();
    const result = store.transition(id, action, ctx());
    if (!result.ok) { showError(result.issues); return; }
    reasonEl.value = "";
    showOk(TRANSITIONS[action].label + " 完成：" + result.mark.code + "（当前状态：" + STATUS[result.mark.status] + "）");
    render(store.getState());
  }

  deleteBtn.addEventListener("click", () => {
    if (!editingId) { showError([{ message: "请先在列表或地图上选择要删除的标记。" }]); return; }
    clearMsg();
    const result = store.deleteMark(editingId, ctx());
    if (!result.ok) { showError(result.issues); return; }
    reasonEl.value = "";
    resetForm(true);
    showOk("已删除。");
  });

  $("#resetBtn").addEventListener("click", () => resetForm(false));

  // ---- 批量操作（任一失败则全部不落地）----

  function runBatch(actionName, pickAction) {
    clearMsg();
    const marks = store.getState().marks;
    const ops = [];
    let skipped = 0;
    selectedIds.forEach((id) => {
      const m = marks.find((x) => x.id === id);
      if (!m) return;
      const action = pickAction(m);
      if (action) ops.push({ type: "transition", id, action });
      else skipped++;
    });
    if (!ops.length) {
      showError([{ message: "所选记录没有可" + actionName + "的（已跳过 " + skipped + " 项）。" }]);
      return;
    }
    const result = store.batch(ops, ctx());
    if (!result.ok) { showError(result.issues); return; }
    selectedIds.clear();
    checkAll.checked = false;
    reasonEl.value = "";
    showOk("批量" + actionName + "完成，共 " + ops.length + " 项" + (skipped ? "（跳过 " + skipped + " 项）" : "") + "。");
    render(store.getState());
  }

  $("#batchReviewBtn").addEventListener("click", () =>
    runBatch("提交复核", (m) => (m.status === "collected" ? "submitReview" : m.status === "returned" ? "resubmit" : null)));
  $("#batchApproveBtn").addEventListener("click", () =>
    runBatch("通过入库", (m) => (m.status === "review" ? "approve" : null)));

  checkAll.addEventListener("change", () => {
    const data = filteredMarks(store.getState().marks);
    if (checkAll.checked) data.forEach((m) => selectedIds.add(m.id));
    else data.forEach((m) => selectedIds.delete(m.id));
    render(store.getState());
  });

  // ---- 撤销 / 重做 ----

  undoBtn.addEventListener("click", () => {
    clearMsg();
    const r = store.undo(ctx());
    if (!r.ok) showError(r.issues); else showOk("已撤销。");
  });
  redoBtn.addEventListener("click", () => {
    clearMsg();
    const r = store.redo(ctx());
    if (!r.ok) showError(r.issues); else showOk("已重做。");
  });
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") { e.preventDefault(); undoBtn.click(); }
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) { e.preventDefault(); redoBtn.click(); }
  });

  // ---- 导出 ----

  $("#exportBtn").addEventListener("click", () => {
    const blob = new Blob([store.exportJSON()], { type: "application/json" });
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    a.href = URL.createObjectURL(blob);
    a.download = "underwater-marks-" + stamp + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  filterType.addEventListener("change", () => render(store.getState()));
  filterStatus.addEventListener("change", () => render(store.getState()));
  view.addEventListener("change", () => render(store.getState()));

  store.subscribe(render);
  resetForm(false);
})();
