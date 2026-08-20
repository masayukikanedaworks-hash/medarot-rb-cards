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

exports.部分的な短い通り芯も符号があれば拾う = async () => {
  const spec = mk.makeSpec();
  // X1.5: 短い（120pt）通り芯で、符号は上辺のみ。実図面の X2.2 / X4.3 に相当
  spec.vAxes.splice(1, 0, { label: "X1.5", mm: 3000, from: 300, to: 420, sides: ["top"] });
  spec.splitsV0 = null;
  const { det, sides } = await analyze(mk.makeBasicPdf(spec));
  const ax = det.v.find((a) => a.label === "X1.5");
  assert.ok(ax, "短い芯でも符号があれば検出される");
  assert.ok(ax.extent < 150, "長さのしきい値未満であること: " + ax.extent);
  assert.deepEqual(ax.bubbles.map((b) => b.side), ["top"], "符号は上辺のみ");
  // 上辺だけ X1.5 で分割され、下辺は通しのまま
  assert.deepEqual(spansOf(sides, "top"), ["X1~X1.5:3000", "X1.5~X2:3000", "X2~X3:5000"]);
  assert.deepEqual(spansOf(sides, "bottom"), ["X1~X2:6000", "X2~X3:5000"]);
};

exports.符号が無い短い線は拾わない = async () => {
  const spec = mk.makeSpec();
  spec.vAxes.splice(1, 0, { label: "X1.5", mm: 3000, from: 300, to: 420, sides: [] }); // 符号なし
  spec.splitsV0 = null;
  const { det } = await analyze(mk.makeBasicPdf(spec));
  assert.equal(det.v.find((a) => a.label === "X1.5"), undefined, "符号が無ければ短い線は芯にしない");
};

exports.右下の小さなキープランは拾わない = async () => {
  const spec = mk.makeSpec();
  // 本図には無い符号（X7/X8/Y7）と、本図と同じ符号（X1/X2/Y1）を小さな図に置く
  spec.keyPlan = { labels: { v: ["X1", "X2", "X7", "X8"], h: ["Y1", "Y7"] } };
  const { det, sides } = await analyze(mk.makeBasicPdf(spec));
  const labels = det.v.concat(det.h).filter((a) => a.label).map((a) => a.label).sort();
  assert.deepEqual(labels.filter((l) => l === "X7" || l === "X8" || l === "Y7"), [], "小さい図の符号は拾わない");
  assert.deepEqual(sides.bottom.axes.map((a) => a.label), ["X1", "X2", "X3"], "本図の符号だけが残る");
  assert.equal(det.groups.length, 2, "図は2つに分かれて認識される");
  assert.equal(det.droppedBubbles > 0, true, "小さい図の符号は除外される");
  // 本図の寸法読み取りは影響を受けない
  const sp = sides.bottom.spans.find((s) => s.from === "X1" && s.to === "X2");
  assert.equal(sp.value, 6000);
};

exports.キープランが無い図面では全ての符号を拾う = async () => {
  const { det } = await analyze(mk.makeBasicPdf());
  assert.equal(det.groups.length <= 1, true, "1つの図なら分割しない");
  assert.equal(det.droppedBubbles, 0);
};
