// 辺別の照合ロジックのテスト（記載寸法どうしの比較・縮尺なし）
"use strict";

const mk = require("./make_pdf");
const { sideOf, near, assert } = require("./helpers");

const CHECKS = { labels: true, spacing: true, total: true };

function cmpOf(base, cmp, tol) {
  return ZC.compare.compare(
    { sides: base.sides, name: "基準" },
    { sides: cmp.sides, name: "比較" },
    { tol: tol === undefined ? 1 : tol, checks: CHECKS }
  );
}

exports.同一図面ならすべてOK = async () => {
  const base = await sideOf(mk.makeBasicPdf(), "基準");
  const cmp = await sideOf(mk.makeBasicPdf(), "比較");
  const r = cmpOf(base, cmp);
  assert.equal(r.summary.ng, 0, JSON.stringify(r.rows.filter((x) => x.status !== "OK")));
  assert.equal(r.summary.warn, 0);
  // 上辺・右辺・下辺・左辺の4辺すべてに結果が出る
  const sides = new Set(r.rows.map((x) => x.side));
  assert.deepEqual([...sides].sort(), ["下辺", "上辺", "右辺", "左辺"].sort());
  const top = r.rows.find((x) => x.side === "上辺" && x.check === "芯々寸法" && x.item === "X1~X2");
  assert.equal(top.base, "6000");
  assert.equal(top.cmp, "6000");
};

exports.記載寸法の違いを辺ごとに検出 = async () => {
  const spec = mk.makeSpec();
  spec.dimsTop = ["6020", "5000"]; // 上辺の記載だけ 6020 に（下辺は 6000 のまま）
  const base = await sideOf(mk.makeBasicPdf(), "基準");
  const cmp = await sideOf(mk.makeBasicPdf(spec), "比較");
  const r = cmpOf(base, cmp);
  const ngs = r.rows.filter((x) => x.status === "NG");
  assert.ok(
    ngs.every((x) => x.side === "上辺"),
    "NGは上辺のみ: " + JSON.stringify(ngs.map((x) => x.side + "/" + x.item))
  );
  const sp = ngs.find((x) => x.check === "芯々寸法" && x.item === "X1~X2");
  assert.equal(sp.base, "6000");
  assert.equal(sp.cmp, "6020");
  near(sp.diff, 20, 0.01);
  // 下辺は一致したまま
  const bottom = r.rows.find((x) => x.side === "下辺" && x.check === "芯々寸法" && x.item === "X1~X2");
  assert.equal(bottom.status, "OK");
};

exports.通り芯の欠落を辺ごとに検出 = async () => {
  const spec = mk.makeSpec();
  spec.vAxes.splice(1, 1); // X2 を削除
  spec.splitsV0 = null;
  const base = await sideOf(mk.makeBasicPdf(), "基準");
  const cmp = await sideOf(mk.makeBasicPdf(spec), "比較");
  const r = cmpOf(base, cmp);
  const miss = r.rows.filter((x) => x.check === "通り芯" && x.item === "X2" && x.status === "NG");
  assert.equal(miss.length, 2, "上辺と下辺の両方で欠落が報告される");
  assert.deepEqual(miss.map((x) => x.side).sort(), ["下辺", "上辺"].sort());
  assert.equal(miss[0].base, "あり");
  assert.equal(miss[0].cmp, "なし");
  // 横方向（左右）は変化なし
  assert.ok(r.rows.filter((x) => x.side === "右辺" || x.side === "左辺").every((x) => x.status === "OK"));
};

exports.許容差の範囲内はOK = async () => {
  const spec = mk.makeSpec();
  spec.dimsTop = ["6000.5", "5000"];
  const base = await sideOf(mk.makeBasicPdf(), "基準");
  const cmp = await sideOf(mk.makeBasicPdf(spec), "比較");
  assert.equal(cmpOf(base, cmp, 1).summary.ng, 0, "±1mmなら許容");
  assert.ok(cmpOf(base, cmp, 0.2).summary.ng > 0, "±0.2mmならNG");
};
