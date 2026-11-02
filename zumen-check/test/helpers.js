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

// 合成ストロークフォントの「形→文字」対応表。
// 実運用では利用者が一度だけ画面で入力する部分を、テストでは既知の字形から作る。
// 回転ごとに別の鍵として登録し、既にある鍵は上書きしない（9 が 6 の180度回転の
// フォントでは rot90(6) と rot270(9) が同じ形になり、取り違えるため）。
function strokeFontMap() {
  const mk = require("./make_pdf");
  const map = {};
  for (const [ch, strokes] of Object.entries(mk.STROKE_FONT)) {
    const segs = strokes.map(([x1, y1, x2, y2]) => ({ x1, y1, x2, y2 }));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of segs) {
      x0 = Math.min(x0, s.x1, s.x2); x1 = Math.max(x1, s.x1, s.x2);
      y0 = Math.min(y0, s.y1, s.y2); y1 = Math.max(y1, s.y1, s.y2);
    }
    const gl = { segs, x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
    for (const turns of [0, 1, 3]) {
      const key = ZC.glyph.shapeOf(ZC.glyph.rotateGlyph(gl, turns));
      if (!(key in map)) map[key] = ch;
    }
  }
  return map;
}

// 線で描かれた文字を読み取ってから、UI と同じ手順で解析する
async function analyzeStroke(bytes, map) {
  const { extract } = await loadFirstPage(bytes);
  const g = ZC.glyph.extract(extract);
  extract.texts = extract.texts.concat(ZC.glyph.toTexts(g.runs, map || strokeFontMap()));
  const det = ZC.axis.detect(extract);
  const dims = ZC.dims.extract(extract);
  const sides = ZC.sides.build(det, dims.entries);
  return { extract, glyph: g, det, dims, sides };
}

// 辺の区間を "X1~X2:6000" の配列にする
function spansOf(sides, key) {
  return sides[key].spans.map((s) => s.from + "~" + s.to + ":" + (s.value == null ? "なし" : s.value));
}

module.exports = { loadFirstPage, analyze, analyzeStroke, strokeFontMap, sideOf, labels, spansOf, near, assert };
