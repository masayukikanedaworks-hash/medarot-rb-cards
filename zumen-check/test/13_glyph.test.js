// 線で描かれた文字（CADのシングルストロークフォント）の読み取りテスト
"use strict";

const mk = require("./make_pdf");
const { loadFirstPage, analyze, analyzeStroke, strokeFontMap, labels, spansOf, assert } = require("./helpers");

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

// 線で描かれた図面でも小数点付きの符号を読む。小数点は字高が digits の
// 1/8 程度しかないので、行の起点にはなれないが行に「加わる」必要がある。
exports.線で描かれた小数点付きの符号も読む = async () => {
  const spec = mk.makeSpec();
  spec.strokeFont = true;
  spec.vAxes.splice(2, 0, { label: "X2.2", mm: 8000 });
  spec.splitsV0 = null;
  const bytes = mk.makeBasicPdf(spec);
  const { det, sides } = await analyzeStroke(bytes);
  assert.deepEqual(labels(det, "v"), ["X1", "X2", "X2.2", "X3"]);
  assert.deepEqual(
    sides.top.spans.map((s) => s.from + "~" + s.to + ":" + s.value),
    ["X1~X2:6000", "X2~X2.2:2000", "X2.2~X3:3000"]
  );
};

// 小数点を教えていないと「X2.2」の行はまるごと捨てられる（半端に読むより安全）。
// そのぶん、小数点の字形は教える画面にちゃんと候補として出る必要がある。
exports.小数点が未登録なら行を捨て教える候補に出す = async () => {
  const spec = mk.makeSpec();
  spec.strokeFont = true;
  spec.vAxes.splice(2, 0, { label: "X2.2", mm: 8000 });
  spec.splitsV0 = null;
  const bytes = mk.makeBasicPdf(spec);
  const full = strokeFontMap();
  const dotKeys = Object.keys(full).filter((k) => full[k] === ".");
  const noDot = {};
  for (const k in full) if (full[k] !== ".") noDot[k] = full[k];

  const { det } = await analyzeStroke(bytes, noDot);
  assert.deepEqual(labels(det, "v"), ["X1", "X2", "X3"], "読めない字がある行は捨てる");

  // 教える画面に出る形（2文字以上の行に出た字形）に小数点が含まれること
  const { extract } = await loadFirstPage(bytes);
  const g = ZC.glyph.extract(extract);
  const kb = {};
  for (const k of dotKeys) kb[k] = ZC.glyph.hexToBits(k);
  const hit = g.shapes.filter((sh) =>
    ZC.glyph.matchShape(ZC.glyph.hexToBits(sh.shape), kb, ZC.glyph.aspectOfKey(sh.shape))
  );
  assert.ok(hit.length >= 1, "小数点の字形が教える候補に出る: " + g.shapes.length + "種");
};

// 90度回転して書かれた符号（構造図の上辺はこの書き方）。
// 回転すると小数点がベースライン側＝字の箱の**反対の端**に付くので、
// 片側だけで行の判定をすると小数点が落ちて X2.2 が X22 になる。
exports.回転した符号でも小数点を読む = async () => {
  const spec = mk.makeSpec();
  spec.strokeFont = true;
  spec.rotLabels = true;
  spec.vAxes.splice(2, 0, { label: "X2.2", mm: 8000 });
  spec.splitsV0 = null;
  const bytes = mk.makeBasicPdf(spec);
  const { extract } = await loadFirstPage(bytes);
  const g = ZC.glyph.extract(extract);
  // 「X」「2」「.」「2」の4字形が1行になること（符号は芯の両端に2回書かれる）
  const H4 = 3.6 * 0.45; // 小さな字形とみなす大きさ
  const runs = g.runs.filter(
    (r) => !r.horizontal && r.glyphs.length === 4 && r.glyphs.some((gl) => gl.w < H4)
  );
  assert.equal(runs.length, 2, "小数点入りの回転した行が両端に1つずつ: " +
    JSON.stringify(g.runs.filter((r) => !r.horizontal).map((r) => r.glyphs.map((gl) => +gl.w.toFixed(2)))));
  const sizes = runs[0].glyphs.map((gl) => +gl.w.toFixed(2));
  assert.equal(sizes.filter((v) => v < H4).length, 1, "小数点は1つだけ: " + JSON.stringify(sizes));

  const { det } = await analyzeStroke(bytes);
  assert.deepEqual(labels(det, "v"), ["X1", "X2", "X2.2", "X3"]);
};

// 教える画面に「小数点らしい形」の候補を出すための印。
// 線で描かれた図面の小数点は線の破片と見分けにくく、未登録が数十種あると
// 利用者が探し当てられないため、ツール側で目星を付ける（確定はしない）。
exports.小数点らしい字形に印が付く = async () => {
  for (const rot of [false, true]) {
    const spec = mk.makeSpec();
    spec.strokeFont = true;
    spec.rotLabels = rot;
    spec.vAxes.splice(2, 0, { label: "X2.2", mm: 8000 });
    spec.splitsV0 = null;
    const { extract } = await loadFirstPage(mk.makeBasicPdf(spec));
    const g = ZC.glyph.extract(extract);
    const full = strokeFontMap();
    const kb = {};
    for (const k in full) kb[k] = ZC.glyph.hexToBits(k);
    const charOf = (sh) => {
      const k = ZC.glyph.matchShape(ZC.glyph.hexToBits(sh), kb, ZC.glyph.aspectOfKey(sh));
      return k ? full[k] : "?";
    };
    const marked = g.shapes.filter((s) => s.dot);
    const where = (rot ? "回転した符号" : "横書きの符号") + ": ";
    assert.equal(marked.length, 1, where + "印が付くのは1種だけ: " +
      JSON.stringify(marked.map((s) => charOf(s.shape))));
    assert.equal(charOf(marked[0].shape), ".", where + "印が付くのは小数点");
    // 小数点なのに印が付かない、が無いこと
    const missed = g.shapes.filter((s) => !s.dot && charOf(s.shape) === ".");
    assert.deepEqual(missed, [], where + "小数点の取りこぼしなし");
  }
};

// 線の破片（行の端にしか出ない形）には印を付けない。
// 小数点がどこにも書かれていない図面なら、印の付く形は 0 種になる。
exports.小数点の無い図面では印が付かない = async () => {
  const spec = mk.makeSpec();
  spec.strokeFont = true;
  spec.splitsV0 = null; // 分割寸法（2730.5 など）を消して小数点を無くす
  const { extract } = await loadFirstPage(mk.makeBasicPdf(spec));
  const g = ZC.glyph.extract(extract);
  const full = strokeFontMap();
  const kb = {};
  for (const k in full) kb[k] = ZC.glyph.hexToBits(k);
  const charOf = (sh) => {
    const k = ZC.glyph.matchShape(ZC.glyph.hexToBits(sh), kb, ZC.glyph.aspectOfKey(sh));
    return k ? full[k] : "?";
  };
  assert.deepEqual(g.shapes.filter((s) => s.dot).map((s) => charOf(s.shape)), [],
    "小数点の無い図面では印が付かない");
  assert.ok(g.shapes.length >= 8, "形自体は出ている: " + g.shapes.length);
};

// 横書きの小数点が「幅ゼロの縦棒」で描かれている図面（実図面の構造図がこれ）。
// この字形は図面の縦線の破片とビット列も縦横比もまったく同じになるので、
// **対応表に教えようがない**（教えると線の破片が全部「.」になる）。
// 形では区別できないので、位置と大きさ（両隣に字があり極小の直線）で決める。
exports.縦棒の小数点は教えなくても読む = async () => {
  const spec = mk.makeSpec();
  spec.strokeFont = true;
  spec.barDot = true;
  spec.vAxes.splice(2, 0, { label: "X2.2", mm: 8000 });
  spec.splitsV0 = null;
  const bytes = mk.makeBasicPdf(spec);
  // 縦棒の字形は「線の破片」として教えないでおく（実図面と同じ状況）
  const full = strokeFontMap();
  const map = {};
  for (const k in full) if (full[k] !== "·") map[k] = full[k];
  assert.ok(Object.keys(map).length < Object.keys(full).length, "縦棒の字形を外せている");

  const { det, sides } = await analyzeStroke(bytes, map);
  assert.deepEqual(labels(det, "v"), ["X1", "X2", "X2.2", "X3"]);
  assert.deepEqual(
    sides.top.spans.map((s) => s.from + "~" + s.to + ":" + s.value),
    ["X1~X2:6000", "X2~X2.2:2000", "X2.2~X3:3000"]
  );
};

// 寸法の数字の小数点（2730.5）も同じように読む
exports.縦棒の小数点は寸法の数字でも読む = async () => {
  const spec = mk.makeSpec();
  spec.strokeFont = true;
  spec.barDot = true;
  const { extract } = await loadFirstPage(mk.makeBasicPdf(spec));
  const g = ZC.glyph.extract(extract);
  const full = strokeFontMap();
  const map = {};
  for (const k in full) if (full[k] !== "·") map[k] = full[k];
  const strs = ZC.glyph.toTexts(g.runs, map).map((t) => t.str);
  for (const want of ["2730.5", "3269.5"]) {
    assert.ok(strs.includes(want), `"${want}" が読めている: ` + JSON.stringify(strs.slice(0, 40)));
  }
  // 推測するのは行の途中の 1 つだけ。"." だけの行や ".." は作らない
  assert.deepEqual(strs.filter((s) => /^\.|\.\./.test(s)), [], JSON.stringify(strs));
};

// 教えられる小数点（塗り潰しの点・斜めの短いストローク）は推測しない。
// 推測を広げると、未登録の小さな字をなんでも小数点として読んでしまう
exports.教えられる小数点は推測で読まない = async () => {
  const spec = mk.makeSpec();
  spec.strokeFont = true;
  spec.vAxes.splice(2, 0, { label: "X2.2", mm: 8000 });
  spec.splitsV0 = null;
  const full = strokeFontMap();
  const map = {};
  for (const k in full) if (full[k] !== ".") map[k] = full[k];
  const { det } = await analyzeStroke(mk.makeBasicPdf(spec), map);
  assert.deepEqual(labels(det, "v"), ["X1", "X2", "X3"], "教えるべき字形は推測しない");
};

// 直線の小数点は「教えない形」として印を付ける。教えると図面の線の破片が
// 全部「.」になってしまうので、教える画面でも候補に入れない
exports.教えてはいけない小数点に印が付く = async () => {
  const bar = mk.makeSpec();
  bar.strokeFont = true;
  bar.barDot = true;
  const g1 = ZC.glyph.extract((await loadFirstPage(mk.makeBasicPdf(bar))).extract);
  const auto = g1.shapes.filter((s) => s.autoDot);
  assert.equal(auto.length, 1, "印が付くのは1種だけ: " + auto.length);
  assert.ok(auto[0].dot, "小数点らしい形でもある");

  // 教えられる（斜めのストロークの）小数点には印を付けない
  const slant = mk.makeSpec();
  slant.strokeFont = true;
  const g2 = ZC.glyph.extract((await loadFirstPage(mk.makeBasicPdf(slant))).extract);
  assert.deepEqual(g2.shapes.filter((s) => s.autoDot), [], "教えられる小数点には印を付けない");
  assert.ok(g2.shapes.some((s) => s.dot), "小数点らしい形自体は出ている");
};
