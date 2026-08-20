// 照合ロジックのテスト
"use strict";

const mk = require("./make_pdf");
const { sideOf, near, assert } = require("./helpers");

const CHECKS = { labels: true, spacing: true, total: true, dims: false };

exports.同一図面ならすべてOK = async () => {
  const base = await sideOf(mk.makeBasicPdf(), "基準");
  const cmp = await sideOf(mk.makeBasicPdf(), "比較");
  const r = ZC.compare.compare(base, cmp, { tol: 1, checks: CHECKS });
  assert.equal(r.summary.ng, 0, "NGなし: " + JSON.stringify(r.rows.filter((x) => x.status !== "OK")));
  assert.equal(r.summary.warn, 0);
  const spacing = r.rows.filter((x) => x.check === "芯々寸法");
  assert.equal(spacing.length, 3, "芯々寸法の行数（縦2+横1）");
  const sp12 = spacing.find((x) => x.item === "X1〜X2");
  assert.equal(sp12.base, "6000.0");
  assert.equal(sp12.cmp, "6000.0");
  const totals = r.rows.filter((x) => x.check === "全体寸法");
  assert.equal(totals.length, 2);

  // ビュワー強調用の芯参照が付き、JSON/CSVには漏れないこと
  assert.equal(sp12.refs.b.length, 2);
  assert.equal(sp12.refs.c.length, 2);
  assert.equal(sp12.refs.b[0].dir, "v");
  assert.ok(!JSON.stringify(sp12).includes("refs"));
};

exports.芯の移動と符号変更を検出 = async () => {
  const spec2 = mk.makeSpec();
  spec2.vAxes[2].mm = 11020; // X3 を +20mm
  spec2.hAxes[1].label = "Y3"; // Y2 → Y3 に改称
  const base = await sideOf(mk.makeBasicPdf(), "基準");
  const cmp = await sideOf(mk.makeBasicPdf(spec2), "比較");
  const r = ZC.compare.compare(base, cmp, { tol: 1, checks: CHECKS });

  const ngs = r.rows.filter((x) => x.status === "NG");
  assert.equal(ngs.length, 3, "NGは3件: " + JSON.stringify(ngs.map((x) => x.check + "/" + x.item)));

  const label = ngs.find((x) => x.check === "符号");
  assert.ok(label && label.item.includes("Y2") && label.item.includes("Y3"), "符号違いが位置対応で報告される");

  const sp = ngs.find((x) => x.check === "芯々寸法");
  assert.equal(sp.item, "X2〜X3");
  near(sp.diff, 20, 0.2, "芯々寸法の差");

  const tot = ngs.find((x) => x.check === "全体寸法");
  assert.equal(tot.item, "X1〜X3");
  near(tot.diff, 20, 0.2, "全体寸法の差");

  // 横方向の芯々寸法は符号が違っても位置対応でOKになる
  const hsp = r.rows.find((x) => x.check === "芯々寸法" && x.item.startsWith("Y1"));
  assert.equal(hsp.status, "OK");
};

exports.芯の欠落を検出 = async () => {
  const spec3 = mk.makeSpec();
  spec3.vAxes.splice(1, 1); // X2 を削除
  const base = await sideOf(mk.makeBasicPdf(), "基準");
  const cmp = await sideOf(mk.makeBasicPdf(spec3), "比較");
  const r = ZC.compare.compare(base, cmp, { tol: 1, checks: CHECKS });
  const miss = r.rows.find((x) => x.check === "符号" && x.status === "NG");
  assert.ok(miss, "欠落がNGで報告される");
  assert.equal(miss.item, "X2");
  assert.equal(miss.base, "あり");
  assert.equal(miss.cmp, "なし");
  // 残った X1〜X3 の芯々寸法は一致
  const sp = r.rows.find((x) => x.check === "芯々寸法" && x.item === "X1〜X3");
  assert.equal(sp.status, "OK");
};

exports.縮尺が違っても実寸で照合される = async () => {
  // 同じ実寸の図面を 1/100 と 1/50 で描いた場合
  const spec50 = mk.makeSpec();
  spec50.den = 50;
  const base = await sideOf(mk.makeBasicPdf(), "基準");
  const cmp = await sideOf(mk.makeBasicPdf(spec50), "比較");
  assert.equal(cmp.inf.den, 50, "1/50 と推定されること");
  const r = ZC.compare.compare(base, cmp, { tol: 1, checks: CHECKS });
  assert.equal(r.summary.ng, 0, JSON.stringify(r.rows.filter((x) => x.status !== "OK")));
};
