// 通り芯検出のテスト（円で囲まれた X○○/Y○○ のみ）
"use strict";

const mk = require("./make_pdf");
const { analyze, labels, near, assert } = require("./helpers");

exports.円で囲まれた符号だけを拾う = async () => {
  const spec = mk.makeSpec();
  const { det } = await analyze(mk.makeBasicPdf(spec));
  assert.deepEqual(labels(det, "v"), ["X1", "X2", "X3"]);
  assert.deepEqual(labels(det, "h"), ["Y1", "Y2"]);

  const expected = mk.axisPositions(spec);
  det.v.filter((a) => a.label).forEach((a, i) => near(a.pos, expected.v[i].pos, 0.15, "縦芯" + (i + 1)));
  det.h.filter((a) => a.label).forEach((a, i) => near(a.pos, expected.h[i].pos, 0.15, "横芯" + (i + 1)));

  // 符号は上下（左右）の両端にあるので、各芯は2つのバブルを持つ
  for (const ax of det.v.filter((a) => a.label)) {
    assert.deepEqual(ax.bubbles.map((b) => b.side).sort(), ["bottom", "top"], ax.label + "のバブル辺");
  }
  for (const ax of det.h.filter((a) => a.label)) {
    assert.deepEqual(ax.bubbles.map((b) => b.side).sort(), ["left", "right"], ax.label + "のバブル辺");
  }

  // 壁線・寸法線・図枠は符号が無いので拾い出し対象外
  const noLabel = det.v.concat(det.h).filter((a) => a.label == null);
  assert.ok(noLabel.length >= 3, "符号なしの候補も検出はされる");
  assert.ok(noLabel.every((a) => !a.defaultOn), "符号なしは既定OFF");
};

exports.円が無ければ符号を拾わない = async () => {
  const spec = mk.makeSpec();
  spec.noBubbles = true; // 文字だけで円囲みなし
  const { det } = await analyze(mk.makeBasicPdf(spec));
  assert.deepEqual(labels(det, "v"), [], "円で囲まれていない符号は拾わない");
  assert.deepEqual(labels(det, "h"), []);
};

exports.小数点付きの符号も拾える = async () => {
  const spec = mk.makeSpec();
  spec.vAxes.splice(1, 0, { label: "X1.5", mm: 3000 });
  spec.hAxes.splice(1, 0, { label: "Y1.7", mm: 2500 });
  spec.splitsV0 = null;
  const { det } = await analyze(mk.makeBasicPdf(spec));
  assert.deepEqual(labels(det, "v"), ["X1", "X1.5", "X2", "X3"]);
  assert.deepEqual(labels(det, "h"), ["Y1", "Y1.7", "Y2"]);
};

exports.回転ページでも同じ検出結果 = async () => {
  const { det } = await analyze(mk.makeBasicPdf(null, { rotate: 90 }));
  assert.deepEqual(labels(det, "v"), ["X1", "X2", "X3"]);
  assert.deepEqual(labels(det, "h"), ["Y1", "Y2"]);
};
