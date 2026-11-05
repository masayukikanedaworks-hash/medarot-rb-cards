// 線で描かれた文字（CADのシングルストロークフォント）の読み取りテスト
"use strict";

const mk = require("./make_pdf");
const { loadFirstPage, analyze, analyzeStroke, strokeFontMap, spansOf, assert } = require("./helpers");

function strokeSpec() {
  const spec = mk.makeSpec();
  spec.strokeFont = true;
  return spec;
}

exports.線で描かれた文字を1文字ずつ切り出す = async () => {
  const { extract } = await loadFirstPage(mk.makeBasicPdf(strokeSpec()));
  assert.ok(extract.texts.length <= 1, "PDFには文字データがほぼ無い: " + extract.texts.length);
  const g = ZC.glyph.extract(extract);
  assert.ok(g.glyphs.length > 40, "字形が切り出せている: " + g.glyphs.length);
  assert.ok(g.runs.length > 10, "行がまとまっている: " + g.runs.length);
  // 使った文字は 0,1,2,3,5,6,7,9,. ,X,Y の11種。図枠などの余りが混ざっても常識的な数に収まる
  assert.ok(g.shapes.length >= 11 && g.shapes.length <= 20, "形の種類: " + g.shapes.length);
  assert.ok(g.shapes[0].count >= g.shapes[g.shapes.length - 1].count, "出現回数の多い順");
};

exports.対応表から文字列を起こす = async () => {
  const { extract } = await loadFirstPage(mk.makeBasicPdf(strokeSpec()));
  const g = ZC.glyph.extract(extract);
  const strs = ZC.glyph.toTexts(g.runs, strokeFontMap()).map((t) => t.str);
  for (const want of ["X1", "X2", "X3", "Y1", "Y2", "6000", "5000", "2730.5", "3269.5"]) {
    assert.ok(strs.includes(want), `"${want}" が読めている: ` + JSON.stringify(strs));
  }
};

exports.対応の無い行は捨てる = async () => {
  const { extract } = await loadFirstPage(mk.makeBasicPdf(strokeSpec()));
  const g = ZC.glyph.extract(extract);
  assert.deepEqual(ZC.glyph.toTexts(g.runs, {}), [], "対応表が空なら何も起こさない");
  // 1文字でも欠けている行は出さない（半端な数字を読むほうが危ないため）
  const full = strokeFontMap();
  const partial = Object.assign({}, full);
  for (const k of Object.keys(partial)) if (partial[k] === "0") delete partial[k];
  const strs = ZC.glyph.toTexts(g.runs, partial).map((t) => t.str);
  assert.equal(strs.some((s) => /0/.test(s)), false, "0 を含む行は出ない: " + JSON.stringify(strs));
  assert.ok(strs.includes("X1"), "0 を含まない行は読める");
};

exports.線で描かれた図面でも文字版と同じ拾い出しになる = async () => {
  const plain = await analyze(mk.makeBasicPdf(mk.makeSpec()));
  const stroke = await analyzeStroke(mk.makeBasicPdf(strokeSpec()));
  for (const side of ["top", "bottom", "left", "right"]) {
    assert.deepEqual(spansOf(stroke.sides, side), spansOf(plain.sides, side), side + " の区間と寸法が一致");
  }
  const labelsOf = (a) => a.det.v.concat(a.det.h).filter((x) => x.label).map((x) => x.label).sort();
  assert.deepEqual(labelsOf(stroke), labelsOf(plain), "通り芯の符号も一致");
};

exports.回転した字形は別の形として扱う = async () => {
  // 9 が 6 の180度回転になっているフォントでは、rot90(6) と rot270(9) が同じ形。
  // 回転でラベルを自動伝播させると 6000 を 9000 と読む事故になる。
  const six = mk.STROKE_FONT["6"].map(([x1, y1, x2, y2]) => ({ x1, y1, x2, y2 }));
  const nine = mk.STROKE_FONT["9"].map(([x1, y1, x2, y2]) => ({ x1, y1, x2, y2 }));
  const box = (segs) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of segs) {
      x0 = Math.min(x0, s.x1, s.x2); x1 = Math.max(x1, s.x1, s.x2);
      y0 = Math.min(y0, s.y1, s.y2); y1 = Math.max(y1, s.y1, s.y2);
    }
    return { segs, x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
  };
  const g6 = box(six);
  const g9 = box(nine);
  assert.notEqual(ZC.glyph.shapeOf(g6), ZC.glyph.shapeOf(g9), "6 と 9 は別の形");
  assert.equal(
    ZC.glyph.shapeOf(ZC.glyph.rotateGlyph(g6, 1)),
    ZC.glyph.shapeOf(ZC.glyph.rotateGlyph(g9, 3)),
    "rot90(6) と rot270(9) は同じ形になりうる（だから自動伝播してはいけない）"
  );
  // toTexts は対応表の鍵をそのまま引くだけで、回転で補完しない
  const map = {};
  map[ZC.glyph.shapeOf(g6)] = "6";
  const run = { horizontal: false, glyphs: [ZC.glyph.rotateGlyph(g6, 1)], x0: 0, y0: 0, x1: 1, y1: 1, size: 1 };
  run.glyphs[0].shape = ZC.glyph.shapeOf(run.glyphs[0]);
  assert.deepEqual(ZC.glyph.toTexts([run], map), [], "回転した形は対応表に無ければ読まない");
};

exports.フォントの指紋は同じ図面で一致する = async () => {
  const a = ZC.glyph.extract((await loadFirstPage(mk.makeBasicPdf(strokeSpec()))).extract);
  const b = ZC.glyph.extract((await loadFirstPage(mk.makeBasicPdf(strokeSpec()))).extract);
  assert.equal(ZC.glyph.fingerprint(a.shapes), ZC.glyph.fingerprint(b.shapes));
  assert.ok(/^g[0-9a-f]+-\d+$/.test(ZC.glyph.fingerprint(a.shapes)));
  // プレビュー用のSVGパスが出る
  assert.ok(ZC.glyph.shapePath(a.shapes[0].glyph, 24).startsWith("M"));
};

exports.細い字形は図面の線の破片と区別する = () => {
  const box = (segs) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of segs) {
      x0 = Math.min(x0, s.x1, s.x2); x1 = Math.max(x1, s.x1, s.x2);
      y0 = Math.min(y0, s.y1, s.y2); y1 = Math.max(y1, s.y1, s.y2);
    }
    return { segs, x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
  };
  // 実図面の X1 の「1」: 幅0.90 x 高さ3.54 の3ストローク
  const one = box([
    { x1: 159.51, y1: 96.62, x2: 159.09, y2: 96.62 },
    { x1: 159.51, y1: 93.62, x2: 159.51, y2: 97.16 },
    { x1: 159.09, y1: 93.62, x2: 159.99, y2: 93.62 },
  ]);
  // 図面の縦線の破片: 幅0 の1ストローク
  const bar = box([{ x1: 200, y1: 90, x2: 200, y2: 92.52 }]);

  const kOne = ZC.glyph.shapeOf(one);
  const kBar = ZC.glyph.shapeOf(bar);
  assert.notEqual(kOne, kBar, "別の鍵になる");
  // 塗りだけ見ると近い（この近さが X1/X10/X11 を読めなくしていた）
  const d = ZC.glyph.shapeDistance(ZC.glyph.bitsOf(one), ZC.glyph.bitsOf(bar));
  assert.ok(d <= ZC.glyph.PARAMS.MAX_DIST, "塗りの距離だけでは区別できない: " + d);
  // 縦横比を見れば分かれる
  assert.ok(
    Math.abs(ZC.glyph.aspectOfGlyph(one) - ZC.glyph.aspectOfGlyph(bar)) > ZC.glyph.PARAMS.ASPECT_TOL,
    "縦横比が十分に違う"
  );
  const keyBits = {};
  keyBits[kBar] = ZC.glyph.hexToBits(kBar);
  assert.equal(
    ZC.glyph.matchShape(ZC.glyph.bitsOf(one), keyBits, ZC.glyph.aspectOfGlyph(one)),
    null,
    "細い「1」は線の破片の鍵に吸われない"
  );
  // 自分自身の鍵には当たる
  const own = {};
  own[kOne] = ZC.glyph.hexToBits(kOne);
  assert.equal(ZC.glyph.matchShape(ZC.glyph.bitsOf(one), own, ZC.glyph.aspectOfGlyph(one)), kOne);
};
