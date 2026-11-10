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

exports.構造図の部材符号は通り芯として拾わない = async () => {
  const spec = mk.makeSpec();
  // 構造図の縦枠符号のように X○.○ / Y○.○ を円無しで大量に散らす
  const marks = [];
  for (let i = 0; i < 5; i++) {
    for (let j = 1; j <= 5; j++) {
      marks.push({ str: "Y" + (i + 1) + "." + j, x: 200 + i * 70, y: 160 + j * 18 });
      marks.push({ str: "X" + (i + 1) + "." + j, x: 200 + j * 40, y: 300 + i * 22 });
    }
  }
  spec.memberMarks = marks;
  const { det, sides } = await analyze(mk.makeBasicPdf(spec));
  const labels = det.v.concat(det.h).filter((a) => a.label != null).map((a) => a.label).sort();
  assert.deepEqual(labels, ["X1", "X2", "X3", "Y1", "Y2"], "円囲みの通り芯だけ: " + JSON.stringify(labels));
  // 通り芯の寸法読み取りは部材符号に影響されない
  const sp = sides.bottom.spans.find((s) => s.from === "X1" && s.to === "X2");
  assert.equal(sp.value, 6000);
};

// --- 小数点付きの通り芯（実図面で落ちていたケース） -----------------------

// CAD は "X2.2" を "X2" と ".2" のように別々の Tj で出すことがある。
// 1 件ずつ読むと "X2" として採られ、小数点付きの芯がそのまま消えていた。
exports.符号が分かれて出力されていても小数点付きで読む = async () => {
  const spec = mk.makeSpec();
  spec.vAxes.splice(2, 0, { label: "X2.2", mm: 8000 });
  spec.splitsV0 = null;
  spec.splitLabels = true;
  const { det, sides } = await analyze(mk.makeBasicPdf(spec));
  assert.deepEqual(labels(det, "v"), ["X1", "X2", "X2.2", "X3"]);
  assert.deepEqual(
    sides.top.spans.map((s) => s.from + "~" + s.to + ":" + s.value),
    ["X1~X2:6000", "X2~X2.2:2000", "X2.2~X3:3000"]
  );
};

// 字数の多い符号は円ではなく横長の長円で囲まれることがある。
// 「正方形に近い」ものしかバブルと認めないと、その芯だけ丸ごと落ちる。
exports.長円のバブルでも符号を拾う = async () => {
  const spec = mk.makeSpec();
  spec.vAxes.splice(2, 0, { label: "X2.2", mm: 8000 });
  spec.splitsV0 = null;
  spec.ovalBubbles = true;
  const { det, extract } = await analyze(mk.makeBasicPdf(spec));
  assert.equal(extract.circles.length, 12, "長円もバブルとして拾う: " + extract.circles.length);
  assert.deepEqual(labels(det, "v"), ["X1", "X2", "X2.2", "X3"]);
};

// 長円 + 分割出力（実図面で両方が重なることがある）
exports.長円のバブルで符号が分かれていても読む = async () => {
  const spec = mk.makeSpec();
  spec.vAxes.splice(2, 0, { label: "X2.2", mm: 8000 });
  spec.splitsV0 = null;
  spec.ovalBubbles = true;
  spec.splitLabels = true;
  const { det, sides } = await analyze(mk.makeBasicPdf(spec));
  assert.deepEqual(labels(det, "v"), ["X1", "X2", "X2.2", "X3"]);
  const sp = sides.top.spans.find((s) => s.from === "X2" && s.to === "X2.2");
  assert.equal(sp && sp.value, 2000);
};

// バブルの中の文字は何でもつなぐわけではない。同じ行で字送りが詰まっている
// ものだけをつなぐ（別行・離れた文字をつなぐと X2 を X27 と誤読してしまう）
exports.バブル内は同じ行で詰まった文字だけつなぐ = () => {
  const J = ZC.axis.joinInBubble;
  const t = (str, x, y, w) => ({ str, x, y, ex: x + w, ey: y, size: 10 });
  // 分かれて出力された符号はつながる
  assert.deepEqual(J([t("X2", 0, 0, 10), t(".2", 10.5, 0, 6)]), ["X2.2"]);
  // 行が違えばつながない
  assert.deepEqual(J([t("X2", 0, 0, 10), t("7", 10.5, 6, 5)]), ["X2", "7"]);
  // 同じ行でも離れていればつながない
  assert.deepEqual(J([t("X2", 0, 0, 10), t("7", 20, 0, 5)]), ["X2", "7"]);
  // 出力順が逆でも読み順に並べ直す
  assert.deepEqual(J([t(".2", 10.5, 0, 6), t("X2", 0, 0, 10)]), ["X2.2"]);
};

// 中黒を小数点の代わりに使うフォント（X2・2）
exports.中黒の小数点も符号として読む = async () => {
  const U = ZC.util;
  assert.deepEqual(U.axisLabelOf("X2・2"), { dir: "v", label: "X2.2" });
  assert.deepEqual(U.axisLabelOf("Ｘ２．２"), { dir: "v", label: "X2.2" });
  assert.equal(U.axisLabelOf("X2-2"), null);
  assert.equal(U.axisLabelOf("X2,2"), null);
};
