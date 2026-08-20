// 記載寸法と作図位置の整合チェック、記載寸法どうしの照合のテスト
"use strict";

const mk = require("./make_pdf");
const { sideOf, near, assert } = require("./helpers");

exports.記載寸法と作図距離の食い違いを検出 = async () => {
  const spec = mk.makeSpec();
  spec.dims.v = ["6100", null]; // 実際は6000mmで作図されているのに記載は6100
  const base = await sideOf(mk.makeBasicPdf(), "基準");
  const cmp = await sideOf(mk.makeBasicPdf(spec), "比較");
  // 多数決により縮尺推定は 1/100 のまま
  assert.equal(cmp.inf.den, 100);
  const r = ZC.compare.compare(base, cmp, {
    tol: 1,
    checks: { labels: false, spacing: false, total: false, dims: true },
  });
  const ngs = r.rows.filter((x) => x.status === "NG");
  assert.equal(ngs.length, 1, JSON.stringify(r.rows));
  const row = ngs[0];
  assert.ok(row.check.includes("比較"), "比較図面側の指摘であること");
  assert.equal(row.item, "X1〜X2");
  near(row.diff, -100, 1, "記載6100に対し作図6000 → 差 -100mm");
  assert.ok(r.rows.filter((x) => x.check.includes("基準")).every((x) => x.status === "OK"));
};

exports.記載寸法どうしで照合されNGと段内食い違いが出る = async () => {
  const spec = mk.makeSpec();
  spec.dims.v = ["6100", null]; // 作図は動かさず記載だけ 6100 に
  const base = await sideOf(mk.makeBasicPdf(), "基準");
  const cmp = await sideOf(mk.makeBasicPdf(spec), "比較");
  const r = ZC.compare.compare(base, cmp, {
    tol: 1,
    checks: { labels: false, spacing: true, total: false, dims: false },
  });
  const sp = r.rows.find((x) => x.check === "芯々寸法" && x.item === "X1〜X2");
  assert.equal(sp.status, "NG", "記載寸法どうしの比較でNGになる");
  assert.equal(sp.base, "6000.0");
  assert.equal(sp.cmp, "6100.0");
  near(sp.diff, 100, 0.2);
  assert.ok(sp.note.includes("食い違"), "段内の食い違い（6100 vs 分割合計6000）が注記される: " + sp.note);
};
