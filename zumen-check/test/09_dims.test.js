// 寸法注記と作図位置の整合チェックのテスト
"use strict";

const mk = require("./make_pdf");
const { sideOf, near, assert } = require("./helpers");

exports.注記寸法と作図距離の食い違いを検出 = async () => {
  const spec = mk.makeSpec();
  spec.dims.v = ["6100", null]; // 実際は6000mmで作図されているのに注記は6100
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
  near(row.diff, -100, 1, "注記6100に対し作図6000 → 差 -100mm");
  // 基準側の注記はすべて整合
  assert.ok(r.rows.filter((x) => x.check.includes("基準")).every((x) => x.status === "OK"));
};
