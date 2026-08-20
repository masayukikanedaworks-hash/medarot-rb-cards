// テスト共通ヘルパ（run.js が先に ZC をグローバルへ読み込んでいる前提）
"use strict";

const assert = require("node:assert/strict");

async function loadFirstPage(bytes) {
  const doc = await ZC.pdf.PDFDocument.load(bytes);
  const pages = await doc.getPages();
  const ex = new ZC.content.ContentExtractor(doc);
  const extract = await ex.run(pages[0]);
  return { doc, pages, extract };
}

// UI と同じ手順: 抽出 → 通り芯検出 → 記載寸法 → 辺別の拾い出し
async function analyze(bytes) {
  const { extract } = await loadFirstPage(bytes);
  const det = ZC.axis.detect(extract);
  const dims = ZC.dims.extract(extract);
  const sides = ZC.sides.build(det, dims.entries);
  return { extract, det, dims, sides };
}

async function sideOf(bytes, name) {
  const a = await analyze(bytes);
  return Object.assign({ name }, a, { sides: a.sides });
}

function labels(det, dir) {
  return det[dir].filter((a) => a.label != null).map((a) => a.label);
}

function near(actual, expected, tol, msg) {
  assert.ok(
    typeof actual === "number" && Math.abs(actual - expected) <= tol,
    (msg || "near") + `: got ${actual}, want ${expected} ±${tol}`
  );
}

// 辺の区間を "X1~X2:6000" の配列にする
function spansOf(sides, key) {
  return sides[key].spans.map((s) => s.from + "~" + s.to + ":" + (s.value == null ? "なし" : s.value));
}

module.exports = { loadFirstPage, analyze, sideOf, labels, spansOf, near, assert };
