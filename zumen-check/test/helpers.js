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

async function detectAxes(bytes) {
  const { extract } = await loadFirstPage(bytes);
  const det = ZC.axis.detect(extract);
  return { extract, det };
}

function onAxes(det) {
  return {
    v: det.v.filter((a) => a.defaultOn),
    h: det.h.filter((a) => a.defaultOn),
  };
}

// UI と同じ手順で照合入力を組み立てる（既定ONの芯 + 記載寸法 + 自動推定縮尺）
async function sideOf(bytes, name) {
  const { extract, det } = await detectAxes(bytes);
  const on = onAxes(det);
  const dims = ZC.dims.extract(extract);
  let samples = ZC.dims.scaleSamples(dims.entries);
  if (!samples.length) samples = ZC.scale.collectDimSamples(on.v, on.h, extract.texts);
  const inf = ZC.scale.infer(samples);
  const mmPerPt = ZC.scale.mmPerPtFromDen(inf.den != null ? inf.den : 100);
  return { v: on.v, h: on.h, mmPerPt, entries: dims.entries, name, inf, det, extract, dims };
}

function near(actual, expected, tol, msg) {
  assert.ok(
    typeof actual === "number" && Math.abs(actual - expected) <= tol,
    (msg || "near") + `: got ${actual}, want ${expected} ±${tol}`
  );
}

module.exports = { loadFirstPage, detectAxes, onAxes, sideOf, near, assert };
