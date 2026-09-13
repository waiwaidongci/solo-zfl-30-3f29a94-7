/* 数据层自动化测试：node --test tests/
 * 覆盖：五类风险拦截、状态机流转、退回补证、批量原子性、
 *       审计留痕（操作者/时间/原因/前后值）、撤销重做、旧数据迁移、持久化、导出。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const MarkStore = require("../js/store.js");

const { ERR, STATUS_KEYS } = MarkStore;

function makeStore(seed) {
  let t = 0;
  let i = 0;
  const storage = MarkStore.memoryAdapter(seed === undefined ? null : seed);
  const store = MarkStore.createStore({
    storage,
    now: () => "2026-09-13T08:" + String(t++).padStart(2, "0") + ":00.000Z",
    idgen: () => "id-" + i++,
  });
  return { store, storage };
}

const ctx = { operator: "张三", reason: "测试原因" };
const goodEvidence = { bagNo: "BAG-1", photoDesc: "全景1张+特写2张", handler: "李四", storage: "柜A-01" };
const goodMark = {
  code: "A-001", type: "ceramic", dive: "DIVE-01", x: 10, y: 20, depth: 18,
  orientation: "东", condition: "稳定", note: "", evidence: goodEvidence,
};

function codes(result) {
  return result.issues.map((i) => i.code);
}

// ---- 基础校验：五类风险分别拦截 ----

test("新增标记成功，缺操作人被拦", () => {
  const { store } = makeStore();
  const bad = store.addMark(goodMark, { operator: "", reason: "" });
  assert.equal(bad.ok, false);
  assert.deepEqual(codes(bad), [ERR.OPERATOR_REQUIRED]);

  const ok = store.addMark(goodMark, ctx);
  assert.equal(ok.ok, true);
  assert.equal(store.getState().marks.length, 1);
  assert.equal(store.getState().marks[0].status, "collected");
});

test("编号重复被拦", () => {
  const { store } = makeStore();
  assert.equal(store.addMark(goodMark, ctx).ok, true);
  const dup = store.addMark({ ...goodMark, code: "A-001" }, ctx);
  assert.equal(dup.ok, false);
  assert.ok(codes(dup).includes(ERR.DUPLICATE_CODE));
  assert.equal(store.getState().marks.length, 1); // 未落地
});

test("位置越界被拦", () => {
  const { store } = makeStore();
  const r1 = store.addMark({ ...goodMark, x: 120 }, ctx);
  assert.ok(codes(r1).includes(ERR.OUT_OF_BOUNDS));
  const r2 = store.addMark({ ...goodMark, y: -0.5 }, ctx);
  assert.ok(codes(r2).includes(ERR.OUT_OF_BOUNDS));
  assert.equal(store.getState().marks.length, 0);
});

test("深度超限与深度无效分别被拦", () => {
  const { store } = makeStore();
  const over = store.addMark({ ...goodMark, depth: 45 }, ctx);
  assert.ok(codes(over).includes(ERR.DEPTH_EXCEEDED));
  const bad = store.addMark({ ...goodMark, depth: "abc" }, ctx);
  assert.ok(codes(bad).includes(ERR.DEPTH_INVALID));
  const edge = store.addMark({ ...goodMark, depth: 40 }, ctx); // 边界值允许
  assert.equal(edge.ok, true);
});

test("保管冲突被拦", () => {
  const { store } = makeStore();
  assert.equal(store.addMark(goodMark, ctx).ok, true);
  const conflict = store.addMark({ ...goodMark, code: "A-002", evidence: { ...goodEvidence } }, ctx);
  assert.ok(codes(conflict).includes(ERR.STORAGE_CONFLICT));
  const ok = store.addMark({ ...goodMark, code: "A-002", evidence: { ...goodEvidence, storage: "柜A-02" } }, ctx);
  assert.equal(ok.ok, true);
});

// ---- 状态机流转 ----

test("证据缺失不能提交复核，补齐后可走完采集→复核→入库", () => {
  const { store } = makeStore();
  const noEvidence = { ...goodMark, evidence: { bagNo: "", photoDesc: "", handler: "", storage: "" } };
  const added = store.addMark(noEvidence, ctx);
  assert.equal(added.ok, true);
  const id = added.mark.id;

  const submit = store.transition(id, "submitReview", ctx);
  assert.equal(submit.ok, false);
  assert.ok(codes(submit).includes(ERR.EVIDENCE_MISSING));
  assert.match(submit.issues[0].message, /采样袋号.*照片说明.*处理人.*保管位置/);
  assert.equal(store.getState().marks[0].status, "collected");

  // 采集状态不能直接入库
  const jump = store.transition(id, "approve", ctx);
  assert.ok(codes(jump).includes(ERR.BAD_TRANSITION));

  assert.equal(store.updateMark(id, { evidence: goodEvidence }, ctx).ok, true);
  assert.equal(store.transition(id, "submitReview", ctx).ok, true);
  assert.equal(store.getState().marks[0].status, "review");
  assert.equal(store.transition(id, "approve", ctx).ok, true);
  assert.equal(store.getState().marks[0].status, "archived");

  // 入库是终态
  const again = store.transition(id, "sendBack", { ...ctx, reason: "想退回" });
  assert.ok(codes(again).includes(ERR.BAD_TRANSITION));
});

test("退回必须写原因；补充证据后才能再次复核", () => {
  const { store } = makeStore();
  const id = store.addMark(goodMark, ctx).mark.id;
  store.transition(id, "submitReview", ctx);

  const noReason = store.transition(id, "sendBack", { operator: "王五", reason: "" });
  assert.ok(codes(noReason).includes(ERR.REASON_REQUIRED));

  const back = store.transition(id, "sendBack", { operator: "王五", reason: "照片模糊，需补拍" });
  assert.equal(back.ok, true);
  const m1 = store.getState().marks[0];
  assert.equal(m1.status, "returned");
  assert.equal(m1.returnReason, "照片模糊，需补拍");

  // 未补充证据直接重新提交 → 拦
  const resub = store.transition(id, "resubmit", ctx);
  assert.ok(codes(resub).includes(ERR.EVIDENCE_UNCHANGED));

  // 补充证据后 → 放行
  assert.equal(store.updateMark(id, { evidence: { ...goodEvidence, photoDesc: "补拍特写3张" } }, ctx).ok, true);
  assert.equal(store.transition(id, "resubmit", ctx).ok, true);
  assert.equal(store.getState().marks[0].status, "review");
});

// ---- 批量操作原子性 ----

test("批量操作任一失败则全部不落地", () => {
  const { store } = makeStore();
  store.addMark(goodMark, ctx); // 已存在 A-001
  const before = store.getState();

  const result = store.batch([
    { type: "add", data: { ...goodMark, code: "B-001", evidence: { ...goodEvidence, storage: "柜B-01" } } },
    { type: "add", data: { ...goodMark, code: "A-001" } }, // 编号重复 → 整批失败
    { type: "add", data: { ...goodMark, code: "B-002", evidence: { ...goodEvidence, storage: "柜B-02" } } },
  ], ctx);

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.code === ERR.DUPLICATE_CODE));
  const after = store.getState();
  assert.equal(after.marks.length, 1); // 一条都没进
  assert.equal(after.audit.length, before.audit.length); // 无审计垃圾
  assert.equal(after.canUndo, before.canUndo); // 无半截撤销项
});

test("批量内部互相冲突也能发现（同批保管位置撞车）", () => {
  const { store } = makeStore();
  const result = store.batch([
    { type: "add", data: { ...goodMark, code: "B-001" } },
    { type: "add", data: { ...goodMark, code: "B-002" } }, // 同批同柜 → 冲突
  ], ctx);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.code === ERR.STORAGE_CONFLICT));
  assert.equal(store.getState().marks.length, 0);
});

test("批量成功为一步，可一次撤销", () => {
  const { store } = makeStore();
  const result = store.batch([
    { type: "add", data: { ...goodMark, code: "B-001", evidence: { ...goodEvidence, storage: "柜B-01" } } },
    { type: "add", data: { ...goodMark, code: "B-002", evidence: { ...goodEvidence, storage: "柜B-02" } } },
    { type: "add", data: { ...goodMark, code: "B-003", evidence: { ...goodEvidence, storage: "柜B-03" } } },
  ], ctx);
  assert.equal(result.ok, true);
  assert.equal(store.getState().marks.length, 3);
  assert.equal(store.undo(ctx).ok, true);
  assert.equal(store.getState().marks.length, 0); // 整批一次撤掉
  assert.equal(store.redo(ctx).ok, true);
  assert.equal(store.getState().marks.length, 3);
});

// ---- 审计留痕 + 撤销重做 ----

test("每次变更保留操作者、时间、原因和前后值", () => {
  const { store } = makeStore();
  const id = store.addMark(goodMark, ctx).mark.id;
  store.updateMark(id, { depth: 21.5 }, { operator: "李四", reason: "复测修正" });

  const audit = store.getState().audit;
  assert.equal(audit.length, 2);
  const e = audit[1];
  assert.equal(e.operator, "李四");
  assert.equal(e.reason, "复测修正");
  assert.ok(e.ts);
  const depthChange = e.changes[0].fields.find((f) => f.field === "depth");
  assert.equal(depthChange.before, 18);
  assert.equal(depthChange.after, 21.5);
});

test("撤销/重做可逆且留痕", () => {
  const { store } = makeStore();
  const id = store.addMark(goodMark, ctx).mark.id;
  store.updateMark(id, { depth: 22 }, ctx);

  assert.equal(store.undo({ operator: "张三" }).ok, true);
  assert.equal(store.getState().marks[0].depth, 18);
  assert.equal(store.redo({ operator: "张三" }).ok, true);
  assert.equal(store.getState().marks[0].depth, 22);

  const actions = store.getState().audit.map((a) => a.action);
  assert.deepEqual(actions, ["create", "update", "undo", "redo"]);
  assert.equal(store.getState().audit[2].operator, "张三"); // 撤销也记操作者

  // 新变更清空重做栈
  store.undo(ctx);
  store.updateMark(id, { depth: 19 }, ctx);
  assert.equal(store.getState().canRedo, false);
});

test("删除必须填原因，删除可撤销恢复", () => {
  const { store } = makeStore();
  const id = store.addMark(goodMark, ctx).mark.id;
  const noReason = store.deleteMark(id, { operator: "张三", reason: "" });
  assert.ok(codes(noReason).includes(ERR.REASON_REQUIRED));
  assert.equal(store.deleteMark(id, { operator: "张三", reason: "误录" }).ok, true);
  assert.equal(store.getState().marks.length, 0);
  assert.equal(store.undo(ctx).ok, true);
  assert.equal(store.getState().marks.length, 1);
  assert.equal(store.getState().marks[0].code, "A-001");
});

// ---- 旧数据迁移 ----

test("v0 旧格式（纯数组、深度带m、无状态证据）升级后仍能打开并继续流转", () => {
  const legacy = [
    { id: "old-1", code: "A-017", type: "ceramic", dive: "DIVE-01", x: 42, y: 46, depth: "17.8m", orientation: "东", condition: "边缘残缺", note: "靠近船肋" },
    { id: "old-2", code: "W-003", type: "wood", dive: "DIVE-02", x: 58, y: 39, depth: "18.2m", orientation: "西北", condition: "稳定", note: "疑似横梁" },
  ];
  const { store } = makeStore(legacy);
  const marks = store.getState().marks;
  assert.equal(marks.length, 2);
  assert.equal(marks[0].status, "collected"); // 默认进入采集态
  assert.equal(marks[0].depth, 17.8); // "17.8m" → 17.8
  assert.deepEqual(marks[0].evidence, { bagNo: "", photoDesc: "", handler: "", storage: "" });

  // 旧标记可编辑、可继续走流程
  assert.equal(store.updateMark("old-1", { condition: "已清理" }, ctx).ok, true);
  const submit = store.transition("old-1", "submitReview", ctx);
  assert.ok(codes(submit).includes(ERR.EVIDENCE_MISSING)); // 老数据缺证据被正确拦住
  assert.equal(store.updateMark("old-1", { evidence: goodEvidence }, ctx).ok, true);
  assert.equal(store.transition("old-1", "submitReview", ctx).ok, true);
});

test("v2 信封格式原样加载，审计序号接续", () => {
  const { store, storage } = makeStore();
  store.addMark(goodMark, ctx);
  const saved = storage.peek();
  assert.equal(saved.version, MarkStore.STORE_VERSION);
  assert.equal(saved.marks.length, 1);
  assert.equal(saved.audit.length, 1);

  // 用同一份持久化数据重开（模拟刷新页面）
  const reopened = MarkStore.createStore({ storage: MarkStore.memoryAdapter(saved) });
  assert.equal(reopened.getState().marks[0].code, "A-001");
  reopened.addMark({ ...goodMark, code: "A-002", evidence: { ...goodEvidence, storage: "柜A-02" } }, ctx);
  const audit = reopened.getState().audit;
  assert.equal(audit[1].seq, 2); // seq 不重置
});

// ---- 导出 ----

test("导出 JSON 含版本、标记与审计，可再解析", () => {
  const { store } = makeStore();
  store.addMark(goodMark, ctx);
  store.transition(store.getState().marks[0].id, "submitReview", ctx);
  const parsed = JSON.parse(store.exportJSON());
  assert.equal(parsed.version, MarkStore.STORE_VERSION);
  assert.equal(parsed.marks.length, 1);
  assert.equal(parsed.marks[0].status, "review");
  assert.equal(parsed.audit.length, 2);
  assert.ok(parsed.exportedAt);
});

test("状态机覆盖：四个状态都有中文名", () => {
  assert.deepEqual(STATUS_KEYS, ["collected", "review", "returned", "archived"]);
});
