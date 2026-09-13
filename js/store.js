/* 水下考古潜水记录 —— 数据层
 *
 * 职责：标本状态机（采集→复核→退回补证→入库）、风险校验、审计日志、
 *       撤销/重做、批量事务、持久化与旧数据迁移。
 * 不依赖 DOM：浏览器中作为全局 MarkStore 使用，Node 中 require 用于自动化测试。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MarkStore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const STORE_VERSION = 2;

  // 标记流转状态：采集 → 复核 →（退回补证 ⇄ 复核）→ 入库
  const STATUS = Object.freeze({
    collected: "采集",
    review: "复核",
    returned: "退回补证",
    archived: "入库",
  });
  const STATUS_KEYS = Object.freeze(Object.keys(STATUS));

  // 每条标本必须记录的证据字段
  const EVIDENCE_FIELDS = Object.freeze([
    ["bagNo", "采样袋号"],
    ["photoDesc", "照片说明"],
    ["handler", "处理人"],
    ["storage", "保管位置"],
  ]);

  // 风险阈值：坐标为平面图百分比，深度为作业安全上限（米）
  const DEFAULT_LIMITS = Object.freeze({ maxDepth: 40, minDepth: 0.1, coordMin: 0, coordMax: 100 });

  // 校验/流转错误码，界面据此分别提示
  const ERR = Object.freeze({
    OPERATOR_REQUIRED: "OPERATOR_REQUIRED",
    CODE_REQUIRED: "CODE_REQUIRED",
    DUPLICATE_CODE: "DUPLICATE_CODE",
    OUT_OF_BOUNDS: "OUT_OF_BOUNDS",
    DEPTH_INVALID: "DEPTH_INVALID",
    DEPTH_EXCEEDED: "DEPTH_EXCEEDED",
    EVIDENCE_MISSING: "EVIDENCE_MISSING",
    STORAGE_CONFLICT: "STORAGE_CONFLICT",
    NOT_FOUND: "NOT_FOUND",
    BAD_TRANSITION: "BAD_TRANSITION",
    ARCHIVED_LOCKED: "ARCHIVED_LOCKED",
    REASON_REQUIRED: "REASON_REQUIRED",
    EVIDENCE_UNCHANGED: "EVIDENCE_UNCHANGED",
    NO_CHANGE: "NO_CHANGE",
    NO_UNDO: "NO_UNDO",
    NO_REDO: "NO_REDO",
  });

  // 状态机：动作 → 允许的来源状态 / 目标状态 / 前置条件
  const TRANSITIONS = Object.freeze({
    submitReview: { from: ["collected"], to: "review", label: "提交复核", needEvidence: true },
    resubmit: { from: ["returned"], to: "review", label: "重新提交复核", needEvidence: true, needEvidenceChanged: true },
    approve: { from: ["review"], to: "archived", label: "通过入库", needEvidence: true },
    sendBack: { from: ["review"], to: "returned", label: "退回补证", needReason: true },
  });

  function issue(code, message, extra) {
    return Object.assign({ code, message }, extra || {});
  }

  function emptyEvidence() {
    return { bagNo: "", photoDesc: "", handler: "", storage: "" };
  }

  function toNumber(v) {
    if (typeof v === "string") v = v.replace(/m\s*$/i, "").trim(); // 兼容旧格式 "17.8m"
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }

  // 统一记录结构，缺省字段补齐；旧数据经此升级
  function normalizeMark(raw, idgen) {
    const m = raw || {};
    const evidence = Object.assign(emptyEvidence(), m.evidence || {});
    for (const [k] of EVIDENCE_FIELDS) evidence[k] = String(evidence[k] == null ? "" : evidence[k]);
    return {
      id: m.id || idgen(),
      code: String(m.code == null ? "" : m.code).trim(),
      type: ["ceramic", "wood", "metal", "unknown"].indexOf(m.type) >= 0 ? m.type : "unknown",
      dive: String(m.dive == null ? "" : m.dive),
      x: toNumber(m.x),
      y: toNumber(m.y),
      depth: toNumber(m.depth),
      orientation: String(m.orientation == null ? "" : m.orientation),
      condition: String(m.condition == null ? "" : m.condition),
      note: String(m.note == null ? "" : m.note),
      status: STATUS_KEYS.indexOf(m.status) >= 0 ? m.status : "collected",
      evidence,
      returnReason: String(m.returnReason || ""),
      returnSnapshot: m.returnSnapshot || null, // 退回时的证据快照：补充证据后才能再次复核
      createdAt: m.createdAt || null,
      updatedAt: m.updatedAt || null,
    };
  }

  // 旧格式迁移：v0 为纯数组（无状态/证据/审计），升级为 v2 信封结构
  function migrate(raw, idgen) {
    const gen = idgen || defaultId;
    if (!raw) return { version: STORE_VERSION, marks: [], audit: [] };
    if (Array.isArray(raw)) {
      return { version: STORE_VERSION, marks: raw.map((m) => normalizeMark(m, gen)), audit: [] };
    }
    const marks = Array.isArray(raw.marks) ? raw.marks : [];
    const audit = Array.isArray(raw.audit) ? raw.audit : [];
    return { version: STORE_VERSION, marks: marks.map((m) => normalizeMark(m, gen)), audit };
  }

  function defaultId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  // 风险校验：编号重复 / 位置越界 / 深度超限 / 保管冲突，各自独立返回
  function validateMark(mark, marks, limits, excludeId) {
    const L = limits || DEFAULT_LIMITS;
    const issues = [];
    if (!mark.code) {
      issues.push(issue(ERR.CODE_REQUIRED, "编号不能为空", { field: "code" }));
    } else if (marks.some((m) => m.id !== excludeId && m.code === mark.code)) {
      issues.push(issue(ERR.DUPLICATE_CODE, "编号重复：" + mark.code + " 已存在", { field: "code" }));
    }
    const inRange = (v) => Number.isFinite(v) && v >= L.coordMin && v <= L.coordMax;
    if (!inRange(mark.x) || !inRange(mark.y)) {
      issues.push(issue(ERR.OUT_OF_BOUNDS,
        "位置越界：坐标需在 " + L.coordMin + "~" + L.coordMax + " 之间（当前 " + mark.x + ", " + mark.y + "）",
        { field: "x" }));
    }
    if (!Number.isFinite(mark.depth) || mark.depth < L.minDepth) {
      issues.push(issue(ERR.DEPTH_INVALID, "深度无效：需为不小于 " + L.minDepth + " 的数字", { field: "depth" }));
    } else if (mark.depth > L.maxDepth) {
      issues.push(issue(ERR.DEPTH_EXCEEDED,
        "深度超限：" + mark.depth + "m 超过安全上限 " + L.maxDepth + "m", { field: "depth" }));
    }
    const storage = (mark.evidence.storage || "").trim();
    if (storage) {
      const hit = marks.find((m) => m.id !== excludeId && (m.evidence.storage || "").trim() === storage);
      if (hit) {
        issues.push(issue(ERR.STORAGE_CONFLICT,
          "保管冲突：位置 " + storage + " 已被 " + hit.code + " 占用", { field: "storage" }));
      }
    }
    return issues;
  }

  // 证据缺失检查：返回缺失字段的中文名列表
  function missingEvidence(mark) {
    return EVIDENCE_FIELDS
      .filter(([k]) => !String(mark.evidence[k] == null ? "" : mark.evidence[k]).trim())
      .map(([, label]) => label);
  }

  // 审计diff跟踪的顶层字段
  const TRACKED_FIELDS = ["code", "type", "dive", "x", "y", "depth", "orientation", "condition", "note", "status", "returnReason"];

  // 允许通过 update/流转patch 修改的字段；status、returnSnapshot 等只能由状态机变更，
  // 防止绕过页面直接注入 {status:"archived"} 之类的写入
  const EDITABLE_FIELDS = ["code", "type", "dive", "x", "y", "depth", "orientation", "condition", "note", "evidence"];

  function sanitizePatch(patch) {
    const clean = {};
    if (!patch || typeof patch !== "object") return clean;
    for (const k of EDITABLE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) clean[k] = patch[k];
    }
    return clean;
  }

  function diffMarks(before, after) {
    const changes = [];
    const beforeById = new Map(before.map((m) => [m.id, m]));
    const afterById = new Map(after.map((m) => [m.id, m]));
    for (const m of after) {
      const b = beforeById.get(m.id);
      if (!b) {
        changes.push({ markId: m.id, code: m.code, kind: "create", fields: [] });
        continue;
      }
      const fields = [];
      for (const f of TRACKED_FIELDS) {
        if (JSON.stringify(b[f]) !== JSON.stringify(m[f])) fields.push({ field: f, before: b[f], after: m[f] });
      }
      for (const [k] of EVIDENCE_FIELDS) {
        if (b.evidence[k] !== m.evidence[k]) {
          fields.push({ field: "evidence." + k, before: b.evidence[k], after: m.evidence[k] });
        }
      }
      if (fields.length) changes.push({ markId: m.id, code: m.code, kind: "update", fields });
    }
    for (const b of before) {
      if (!afterById.has(b.id)) changes.push({ markId: b.id, code: b.code, kind: "delete", fields: [] });
    }
    return changes;
  }

  function createStore(options) {
    const opts = options || {};
    const idgen = opts.idgen || defaultId;
    const now = opts.now || (() => new Date().toISOString());
    const limits = Object.assign({}, DEFAULT_LIMITS, opts.limits || {});
    const storage = opts.storage || null;

    let state = migrate(storage ? storage.load() : null, idgen);
    let undoStack = []; // [{label, before, after, auditSeq}]
    let redoStack = [];
    let seq = state.audit.reduce((m, e) => Math.max(m, e.seq || 0), 0);
    const listeners = new Set();

    const clone = (v) => JSON.parse(JSON.stringify(v));

    function persist() {
      if (storage) {
        try { storage.save(clone(state)); } catch (e) { /* 存储满等异常不阻断操作 */ }
      }
    }
    function getState() {
      return {
        marks: clone(state.marks),
        audit: clone(state.audit),
        canUndo: undoStack.length > 0,
        canRedo: redoStack.length > 0,
        undoLabel: undoStack.length ? undoStack[undoStack.length - 1].label : "",
        redoLabel: redoStack.length ? redoStack[redoStack.length - 1].label : "",
        limits: Object.assign({}, limits),
      };
    }
    function emit() {
      const s = getState();
      listeners.forEach((fn) => fn(s));
    }
    function subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }

    function checkCtx(ctx) {
      if (!ctx || !String(ctx.operator || "").trim()) {
        return [issue(ERR.OPERATOR_REQUIRED, "请先填写操作人")];
      }
      return null;
    }

    // 所有写操作的唯一入口：校验 → 应用 → 审计 → 入撤销栈 → 持久化
    function commit(label, ctx, applyFn) {
      const ctxIssues = checkCtx(ctx);
      if (ctxIssues) return { ok: false, issues: ctxIssues };
      const before = clone(state.marks);
      const draft = clone(state.marks);
      let result;
      try {
        result = applyFn(draft);
      } catch (e) {
        if (e && e.issues) return { ok: false, issues: e.issues }; // 校验失败：状态原样不动
        throw e;
      }
      const changes = diffMarks(before, draft);
      if (!changes.length) return { ok: false, issues: [issue(ERR.NO_CHANGE, "没有可保存的变更")] };
      state.marks = draft;
      seq += 1;
      state.audit.push({
        seq,
        ts: now(),
        operator: String(ctx.operator).trim(),
        action: result.action,
        label,
        reason: String(ctx.reason || ""),
        changes,
      });
      undoStack.push({ label, before, after: clone(draft), auditSeq: seq });
      redoStack = [];
      persist();
      emit();
      return Object.assign({ ok: true }, result);
    }

    // ---- 单个操作（在 draft 上执行，失败抛 {issues}，由 commit 统一拦截）----

    function opAdd(draft, data) {
      const mark = normalizeMark(data, idgen);
      mark.createdAt = now();
      mark.updatedAt = mark.createdAt;
      const issues = validateMark(mark, draft, limits, null);
      if (issues.length) throw { issues };
      draft.push(mark);
      return mark;
    }

    function opUpdate(draft, id, patch) {
      const idx = draft.findIndex((m) => m.id === id);
      if (idx < 0) throw { issues: [issue(ERR.NOT_FOUND, "记录不存在：" + id)] };
      if (draft[idx].status === "archived") {
        throw { issues: [issue(ERR.ARCHIVED_LOCKED, "已入库，不能再修改（如需改动请先撤销入库）", { field: "status" })] };
      }
      const merged = normalizeMark(Object.assign({}, draft[idx], sanitizePatch(patch), { id, createdAt: draft[idx].createdAt }), idgen);
      merged.updatedAt = now();
      const issues = validateMark(merged, draft, limits, id);
      if (issues.length) throw { issues };
      draft[idx] = merged;
      return merged;
    }

    function opDelete(draft, id, ctx) {
      const idx = draft.findIndex((m) => m.id === id);
      if (idx < 0) throw { issues: [issue(ERR.NOT_FOUND, "记录不存在：" + id)] };
      if (draft[idx].status === "archived") {
        throw { issues: [issue(ERR.ARCHIVED_LOCKED, "已入库，不能删除（如需移除请先撤销入库）", { field: "status" })] };
      }
      if (!String((ctx && ctx.reason) || "").trim()) {
        throw { issues: [issue(ERR.REASON_REQUIRED, "删除必须填写原因", { field: "reason" })] };
      }
      draft.splice(idx, 1);
    }

    // 流转可携带未保存的表单修改（patch），与状态变更同一事务提交：
    // 退回补证后改完证据直接点“重新提交复核”即可，无需先单独保存
    function opTransition(draft, id, action, ctx, patch) {
      const idx = draft.findIndex((m) => m.id === id);
      if (idx < 0) throw { issues: [issue(ERR.NOT_FOUND, "记录不存在：" + id)] };
      const t = TRANSITIONS[action];
      if (!t) throw { issues: [issue(ERR.BAD_TRANSITION, "未知操作：" + action)] };
      if (t.from.indexOf(draft[idx].status) < 0) {
        throw { issues: [issue(ERR.BAD_TRANSITION, "当前状态「" + STATUS[draft[idx].status] + "」不能" + t.label)] };
      }
      let mark = draft[idx];
      if (patch) {
        mark = normalizeMark(Object.assign({}, mark, sanitizePatch(patch), { id: mark.id, createdAt: mark.createdAt }), idgen);
        mark.updatedAt = now();
        draft[idx] = mark;
      }
      const issues = [];
      if (t.needReason && !String((ctx && ctx.reason) || "").trim()) {
        issues.push(issue(ERR.REASON_REQUIRED, t.label + "必须填写原因", { field: "reason" }));
      }
      if (t.needEvidence) {
        const missing = missingEvidence(mark);
        if (missing.length) {
          issues.push(issue(ERR.EVIDENCE_MISSING, "证据缺失：" + missing.join("、"), { field: "evidence" }));
        }
      }
      if (t.needEvidenceChanged && mark.returnSnapshot &&
          JSON.stringify(mark.evidence) === JSON.stringify(mark.returnSnapshot)) {
        issues.push(issue(ERR.EVIDENCE_UNCHANGED, "退回后证据未补充，不能再次提交复核", { field: "evidence" }));
      }
      // 流转前再过一遍风险校验（编号/位置/深度/保管），问题各自独立上报
      issues.push.apply(issues, validateMark(mark, draft, limits, id));
      if (issues.length) throw { issues };
      mark.status = t.to;
      mark.updatedAt = now();
      if (action === "sendBack") {
        mark.returnReason = String(ctx.reason).trim();
        mark.returnSnapshot = clone(mark.evidence);
      }
      if (action === "approve") {
        mark.returnReason = "";
        mark.returnSnapshot = null;
      }
      return mark;
    }

    function applyOp(draft, op, ctx) {
      switch (op.type) {
        case "add": return opAdd(draft, op.data || {});
        case "update": return opUpdate(draft, op.id, op.patch || {});
        case "delete": return opDelete(draft, op.id, ctx);
        case "transition": return opTransition(draft, op.id, op.action, ctx, op.patch);
        default: throw { issues: [issue(ERR.BAD_TRANSITION, "未知批量操作类型：" + op.type)] };
      }
    }

    // ---- 对外 API ----

    function addMark(data, ctx) {
      return commit("新增标记 " + ((data && data.code) || ""), ctx, (draft) => {
        const mark = opAdd(draft, data || {});
        return { action: "create", mark: clone(mark) };
      });
    }

    function updateMark(id, patch, ctx) {
      return commit("修改标记", ctx, (draft) => {
        const mark = opUpdate(draft, id, patch);
        return { action: "update", mark: clone(mark) };
      });
    }

    function deleteMark(id, ctx) {
      return commit("删除标记", ctx, (draft) => {
        opDelete(draft, id, ctx);
        return { action: "delete" };
      });
    }

    function transition(id, action, ctx, patch) {
      const t = TRANSITIONS[action];
      const label = t ? t.label : action;
      return commit(label, ctx, (draft) => {
        const mark = opTransition(draft, id, action, ctx || {}, patch);
        return { action: "transition:" + action, mark: clone(mark) };
      });
    }

    // 批量操作：全部在草稿上校验并收集问题，任一失败则整体不落地（不能只保存一半）
    function batch(ops, ctx) {
      return commit("批量操作（" + (ops || []).length + " 项）", ctx, (draft) => {
        const allIssues = [];
        (ops || []).forEach((op, i) => {
          try {
            applyOp(draft, op, ctx);
          } catch (e) {
            if (e && e.issues) {
              const tag = op.id ? (draft.find((m) => m.id === op.id) || {}).code : (op.data && op.data.code);
              e.issues.forEach((is) => allIssues.push(issue(is.code, "第" + (i + 1) + "项" + (tag ? "（" + tag + "）" : "") + "：" + is.message, is)));
            } else throw e;
          }
        });
        if (allIssues.length) throw { issues: allIssues };
        return { action: "batch" };
      });
    }

    function undo(ctx) {
      const cmd = undoStack.pop();
      if (!cmd) return { ok: false, issues: [issue(ERR.NO_UNDO, "没有可撤销的操作")] };
      const ctxIssues = checkCtx(ctx);
      if (ctxIssues) { undoStack.push(cmd); return { ok: false, issues: ctxIssues }; }
      redoStack.push(cmd);
      // 与普通变更一样留痕：操作者、时间、原因、逐字段前后值
      const before = clone(state.marks);
      state.marks = clone(cmd.before);
      const changes = diffMarks(before, state.marks);
      seq += 1;
      state.audit.push({
        seq, ts: now(), operator: String(ctx.operator).trim(),
        action: "undo", label: "撤销：" + cmd.label, reason: String(ctx.reason || ""),
        changes, undoOf: cmd.auditSeq,
      });
      persist();
      emit();
      return { ok: true };
    }

    function redo(ctx) {
      const cmd = redoStack.pop();
      if (!cmd) return { ok: false, issues: [issue(ERR.NO_REDO, "没有可重做的操作")] };
      const ctxIssues = checkCtx(ctx);
      if (ctxIssues) { redoStack.push(cmd); return { ok: false, issues: ctxIssues }; }
      undoStack.push(cmd);
      const before = clone(state.marks);
      state.marks = clone(cmd.after);
      const changes = diffMarks(before, state.marks);
      seq += 1;
      state.audit.push({
        seq, ts: now(), operator: String(ctx.operator).trim(),
        action: "redo", label: "重做：" + cmd.label, reason: String(ctx.reason || ""),
        changes, redoOf: cmd.auditSeq,
      });
      persist();
      emit();
      return { ok: true };
    }

    function exportJSON() {
      return JSON.stringify({
        version: STORE_VERSION,
        exportedAt: now(),
        limits,
        marks: state.marks,
        audit: state.audit,
      }, null, 2);
    }

    return {
      getState, subscribe,
      addMark, updateMark, deleteMark, transition, batch,
      undo, redo, exportJSON,
    };
  }

  // ---- 存储适配器 ----

  function localStorageAdapter(key) {
    return {
      load() {
        try {
          const s = localStorage.getItem(key);
          return s ? JSON.parse(s) : null;
        } catch (e) { return null; }
      },
      save(state) {
        try { localStorage.setItem(key, JSON.stringify(state)); } catch (e) { /* 忽略配额错误 */ }
      },
    };
  }

  function memoryAdapter(initial) {
    let data = initial === undefined ? null : initial;
    return {
      load: () => data,
      save: (s) => { data = s; },
      peek: () => data,
    };
  }

  return {
    createStore,
    migrate,
    validateMark,
    missingEvidence,
    localStorageAdapter,
    memoryAdapter,
    STATUS,
    STATUS_KEYS,
    EVIDENCE_FIELDS,
    TRANSITIONS,
    ERR,
    DEFAULT_LIMITS,
    STORE_VERSION,
  };
});
