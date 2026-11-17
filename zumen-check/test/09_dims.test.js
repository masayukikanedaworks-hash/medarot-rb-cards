// 寸法段の食い違い・記載なしの扱いのテスト
"use strict";

const mk = require("./make_pdf");
const { analyze, sideOf, assert } = require("./helpers");

exports.寸法段どうしの食い違いを注記する = async () => {
  const spec = mk.makeSpec();
  spec.dims.v = ["6100", null]; // 下辺の通り段を6100に（分割段の合計6000と食い違い）
  const { sides } = await analyze(mk.makeBasicPdf(spec));
  const sp = sides.bottom.spans.find((s) => s.from === "X1" && s.to === "X2");
  assert.equal(sp.value, 6100, "通り段の値を採用");
  assert.equal(sp.conflict, true, "分割段の合計との食い違いを検出");
  assert.ok(ZC.sides.formatSpan(sp).includes("食い違い"));
};

exports.記載寸法が無い区間は要確認になる = async () => {
  const spec = mk.makeSpec();
  spec.dimsRight = [null]; // 右辺の寸法注記を消す
  const base = await sideOf(mk.makeBasicPdf(), "基準");
  const cmp = await sideOf(mk.makeBasicPdf(spec), "比較");
  const r = ZC.compare.compare(
    { sides: base.sides, name: "基準" },
    { sides: cmp.sides, name: "比較" },
    { tol: 1, checks: { labels: true, spacing: true, total: true } }
  );
  const warn = r.rows.filter((x) => x.status === "WARN");
  assert.ok(warn.length >= 1, "要確認が出ること");
  assert.ok(warn.every((x) => x.side === "右辺"), "右辺のみ要確認: " + JSON.stringify(warn.map((x) => x.side)));
  assert.ok(warn[0].note.includes("記載寸法が見つかりません"));
  assert.equal(r.summary.ng, 0, "値が読めない区間はNGにしない");
};

exports["W＝の開口幅は数字だけを寸法として読む"] = () => {
  assert.equal(ZC.util.parseDimNumber("W= 1650"), 1650, "W＝付きは数字だけ読む");
  assert.equal(ZC.util.parseDimNumber("Ｗ＝1650"), 1650, "全角も同じ");
  assert.equal(ZC.util.parseDimNumber("1650"), 1650);
  assert.equal(ZC.util.parseDimNumber("H=1650"), null, "W＝以外の接頭辞は拾わない");
  assert.equal(ZC.util.isWidthNote("W= 900"), true);
  assert.equal(ZC.util.isWidthNote("900"), false);
};

exports.黒ドットが極小の円弧で描かれていても読む = async () => {
  // 実図面の構造図は 1 つの黒ドットを上下 2 つの半円（幅0.6×高さ0.3）で描く。
  // 塗りでも太線でも閉じた円でもないため、弧として拾えないと寸法が 0 件になる。
  const spec = mk.makeSpec();
  spec.arcDots = true;
  const { dims, sides } = await analyze(mk.makeBasicPdf(spec));
  assert.ok(dims.dots.length >= 10, "円弧のドットが拾えている: " + dims.dots.length);
  assert.ok(dims.entries.length >= 6, "寸法が読めている: " + dims.entries.length);
  const sp = sides.bottom.spans.find((s) => s.from === "X1" && s.to === "X2");
  assert.equal(sp.value, 6000, "塗りドットの図面と同じ値になる");
  assert.deepEqual(sp.parts, [2730.5, 3269.5]);
};

// --- 1つの数字を縦横ふたつの寸法に使わない -------------------------------

// 線分1本ぶんのヘルパ（ZC.dims.extract は dots / texts / segments しか見ない）
function seg(x1, y1, x2, y2) {
  return { x1, y1, x2, y2, w: 0.3 };
}

// 実図面で発生: 横段の数字（2222.5）が、すぐ右にある**縦列**の数字としても
// 使われ、同じ寸法が横書きと90度回転の2つに出ていた。
// 数字は縦横をまたいで1回しか使わない。
exports.同じ数字を縦横ふたつの寸法に使わない = () => {
  const ex = {
    // 横段: y=100 に 2 点（x=0 と x=40）。数字は線の上・中央に横書き
    // 縦列: x=28 に 2 点（y=90 と y=110）。数字は書かれていないが、
    //       横段の数字が「線のすぐ左・列の中央」に来てしまう配置
    dots: [{ x: 0, y: 100 }, { x: 40, y: 100 }, { x: 28, y: 90 }, { x: 28, y: 110 }],
    segments: [seg(0, 100, 40, 100), seg(28, 90, 28, 110)],
    texts: [{ str: "2222.5", x: 16, y: 101.5, ex: 24, ey: 101.5, size: 3 }],
  };
  const r = ZC.dims.extract(ex);
  const got = r.entries.map((e) => e.dir + ":" + e.value);
  assert.deepEqual(got, ["v:2222.5"], "数字を使うのは横段だけ: " + JSON.stringify(got));
};

// 縦列に90度回転で書かれた数字は、ちゃんと縦列のものとして読む
exports.縦列の数字は回転して書かれていても読む = () => {
  const ex = {
    dots: [{ x: 0, y: 100 }, { x: 40, y: 100 }, { x: 28, y: 90 }, { x: 28, y: 110 }],
    segments: [seg(0, 100, 40, 100), seg(28, 90, 28, 110)],
    texts: [
      { str: "2222.5", x: 16, y: 101.5, ex: 24, ey: 101.5, size: 3 }, // 横段の数字
      { str: "1234", x: 26.5, y: 96, ex: 26.5, ey: 104, size: 3 },    // 縦列の数字（回転）
    ],
  };
  const r = ZC.dims.extract(ex);
  const got = r.entries.map((e) => e.dir + ":" + e.value).sort();
  assert.deepEqual(got, ["h:1234", "v:2222.5"], JSON.stringify(got));
};

// どの数字から読んだかを持ち回る（図上で同じ向きに描くのに使う）
exports.寸法は読み取り元の数字を持つ = () => {
  const ex = {
    dots: [{ x: 0, y: 100 }, { x: 40, y: 100 }],
    segments: [seg(0, 100, 40, 100)],
    texts: [{ str: "2222.5", x: 16, y: 101.5, ex: 24, ey: 101.5, size: 3 }],
  };
  const e = ZC.dims.extract(ex).entries[0];
  assert.equal(e.text.str, "2222.5");
  assert.equal(e.text.horizontal, true, "横書きの数字から読んだ");
  assert.equal(JSON.stringify(e).includes("text"), false, "JSONには出さない");
};

// 狭い区間の数字は90度回転して書かれる。平行な数字が無ければ回転も受け付ける
exports.狭い区間の回転した数字も読む = () => {
  const ex = {
    dots: [{ x: 0, y: 100 }, { x: 8, y: 100 }],
    segments: [seg(0, 100, 8, 100)],
    texts: [{ str: "910", x: 4, y: 101, ex: 4, ey: 107, size: 3 }], // 90度回転
  };
  const r = ZC.dims.extract(ex);
  assert.deepEqual(r.entries.map((e) => e.dir + ":" + e.value), ["v:910"]);
  assert.equal(r.entries[0].text.horizontal, false, "回転した数字から読んだ");
};
