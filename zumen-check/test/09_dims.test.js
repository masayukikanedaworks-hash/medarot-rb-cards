// 寸法段の食い違い・記載なしの扱いのテスト
"use strict";

const mk = require("./make_pdf");
const { analyze, sideOf, assert } = require("./helpers");

exports.寸法段どうしの食い違いを注記する = async () => {
  const spec = mk.makeSpec();
  spec.dims.v = ["6100", null]; // 下辺の通り段を6100に（分割段の合計6000と食い違い）
  const { sides } = await analyze(mk.makeBasicPdf(spec));
  const sp = sides.bottom.spans.find((s) => s.from === "X1" && s.to === "X2");
  assert.equal(sp.value, 6100, "通り段の値を採用");
  assert.equal(sp.conflict, true, "分割段の合計との食い違いを検出");
  assert.ok(ZC.sides.formatSpan(sp).includes("食い違い"));
};

exports.記載寸法が無い区間は要確認になる = async () => {
  const spec = mk.makeSpec();
  spec.dimsRight = [null]; // 右辺の寸法注記を消す
  const base = await sideOf(mk.makeBasicPdf(), "基準");
  const cmp = await sideOf(mk.makeBasicPdf(spec), "比較");
  const r = ZC.compare.compare(
    { sides: base.sides, name: "基準" },
    { sides: cmp.sides, name: "比較" },
    { tol: 1, checks: { labels: true, spacing: true, total: true } }
  );
  const warn = r.rows.filter((x) => x.status === "WARN");
  assert.ok(warn.length >= 1, "要確認が出ること");
  assert.ok(warn.every((x) => x.side === "右辺"), "右辺のみ要確認: " + JSON.stringify(warn.map((x) => x.side)));
  assert.ok(warn[0].note.includes("記載寸法が見つかりません"));
  assert.equal(r.summary.ng, 0, "値が読めない区間はNGにしない");
};
