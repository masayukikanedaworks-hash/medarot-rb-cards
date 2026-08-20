// 記載寸法の読み取り（黒ドット間の直線の上の数字）と辺別振り分けのテスト
"use strict";

const mk = require("./make_pdf");
const { analyze, spansOf, assert } = require("./helpers");

exports.ドットと記載寸法の抽出 = async () => {
  const { extract, dims } = await analyze(mk.makeBasicPdf());
  assert.equal(dims.dots.length, 13, "ドット数（下辺3+3・上辺3・左2・右2）");
  assert.equal(dims.entries.length, 8, "記載寸法の区間数: " + JSON.stringify(dims.entries.map((e) => e.value)));
  const values = dims.entries.map((e) => e.value).sort((a, b) => a - b);
  assert.deepEqual(values, [2730.5, 3269.5, 5000, 5000, 6000, 6000, 6000, 6000], "小数を含む記載値が読めること");
  assert.ok(extract.circles.length > 0);
};

exports.通り芯間は通り段を採用し内訳を併記する = async () => {
  const { sides } = await analyze(mk.makeBasicPdf());
  const sp = sides.bottom.spans.find((s) => s.from === "X1" && s.to === "X2");
  assert.equal(sp.value, 6000, "通り段の値");
  assert.deepEqual(sp.parts, [2730.5, 3269.5], "分割段を内訳として併記");
  assert.equal(sp.conflict, false);
  assert.equal(ZC.sides.formatSpan(sp), "X1~X2：6000（2730.5+3269.5）");
  // 上辺は分割段が無いので内訳なし
  const top = sides.top.spans.find((s) => s.from === "X1" && s.to === "X2");
  assert.equal(ZC.sides.formatSpan(top), "X1~X2：6000");
};

exports.分割記載しか無い区間は合計で読む = async () => {
  const spec = mk.makeSpec();
  spec.noRow2 = true; // 下辺は分割段（2730.5 + 3269.5）だけ
  const { sides } = await analyze(mk.makeBasicPdf(spec));
  const sp = sides.bottom.spans.find((s) => s.from === "X1" && s.to === "X2");
  assert.equal(sp.value, 6000, "分割チェーンの合計");
  assert.deepEqual(sp.parts, [2730.5, 3269.5]);
  // 段が無い X2〜X3 は記載なし
  const sp23 = sides.bottom.spans.find((s) => s.from === "X2" && s.to === "X3");
  assert.equal(sp23.value, null);
  assert.ok(ZC.sides.formatSpan(sp23).includes("記載なし"));
};

exports.辺ごとに別の寸法を読む = async () => {
  const spec = mk.makeSpec();
  spec.dimsTop = ["5917", "3175"]; // 上辺だけ別の記載
  spec.dimsRight = ["4200"]; // 右辺だけ別の記載
  const { sides } = await analyze(mk.makeBasicPdf(spec));
  assert.deepEqual(spansOf(sides, "top"), ["X1~X2:5917", "X2~X3:3175"]);
  assert.deepEqual(spansOf(sides, "bottom"), ["X1~X2:6000", "X2~X3:5000"]);
  assert.deepEqual(spansOf(sides, "right"), ["Y1~Y2:4200"]);
  assert.deepEqual(spansOf(sides, "left"), ["Y1~Y2:6000"]);
};

exports.小数点付きの寸法と符号を拾う = async () => {
  const spec = mk.makeSpec();
  spec.vAxes.splice(1, 0, { label: "X1.5", mm: 3000 });
  spec.splitsV0 = null;
  spec.dims.v = ["3000.5", "2999.5", "5000"];
  spec.dimsTop = ["3000.5", "2999.5", "5000"];
  const { sides } = await analyze(mk.makeBasicPdf(spec));
  assert.deepEqual(spansOf(sides, "top"), ["X1~X1.5:3000.5", "X1.5~X2:2999.5", "X2~X3:5000"]);
  assert.equal(ZC.sides.formatSpan(sides.top.spans[0]), "X1~X1.5：3000.5");
};

exports.全体寸法は端から端までのチェーン合計 = async () => {
  const { sides } = await analyze(mk.makeBasicPdf());
  assert.equal(sides.top.total.from, "X1");
  assert.equal(sides.top.total.to, "X3");
  assert.equal(sides.top.total.value, 11000, "6000+5000");
};
