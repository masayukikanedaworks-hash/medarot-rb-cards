// コンテントストリームからの線分・テキスト・ドット・符号バブル抽出テスト
"use strict";

const mk = require("./make_pdf");
const { loadFirstPage, near, assert } = require("./helpers");

exports.線分とテキストの抽出 = async () => {
  const { extract } = await loadFirstPage(mk.makeBasicPdf());
  assert.equal(extract.width, 842);
  assert.equal(extract.height, 595);
  assert.ok(extract.segments.length > 30, "線分が抽出されること");

  // 図枠 (re) の一辺
  const frame = extract.segments.find(
    (s) => Math.abs(s.y1 - 20) < 0.01 && Math.abs(s.y2 - 20) < 0.01 && Math.abs(s.x1 - s.x2) > 700
  );
  assert.ok(frame, "図枠のreが線分になること");

  // 破線指定の通り芯（X1: dパターン付きの縦線）
  const x1 = extract.segments.find(
    (s) => s.dashed && Math.abs(s.x1 - mk.X0) < 0.01 && Math.abs(s.x2 - mk.X0) < 0.01 && Math.abs(s.y2 - s.y1) > 400
  );
  assert.ok(x1, "dパターンの縦通り芯が dashed で抽出されること");

  // 符号バブル: 縦3本×上下 + 横2本×左右 = 10個
  assert.equal(extract.circles.length, 10, "符号バブル（円）の数");
  const bubbleX1Top = extract.circles.find((c) => Math.abs(c.x - mk.X0) < 0.5 && c.y > 500);
  assert.ok(bubbleX1Top, "X1上端のバブルが検出されること");
  near(bubbleX1Top.r, mk.BUBBLE_R, 0.5, "バブル半径");

  // 寸法線端点の黒ドット: 下辺(3+3) + 上辺3 + 左2 + 右2 = 13
  assert.equal(extract.dots.length, 13, "黒ドットの数");

  // ラベルテキスト
  const tX1 = extract.texts.filter((t) => t.str === "X1");
  assert.equal(tX1.length, 2, "X1ラベルは上下2箇所");

  // 90度回転した寸法文字（縦の寸法線用）も向き付きで抽出される
  const rot = extract.texts.find((t) => t.str === "6000" && Math.abs(t.ey - t.y) > Math.abs(t.ex - t.x));
  assert.ok(rot, "回転テキストが抽出されること");
};

exports.回転ページは表示向きに補正される = async () => {
  const base = await loadFirstPage(mk.makeBasicPdf());
  const rot = await loadFirstPage(mk.makeBasicPdf(null, { rotate: 90 }));
  assert.equal(rot.extract.width, 842, "回転後の表示幅");
  assert.equal(rot.extract.height, 595, "回転後の表示高さ");
  assert.equal(rot.extract.circles.length, base.extract.circles.length);
  assert.equal(rot.extract.dots.length, base.extract.dots.length);
  const tBase = base.extract.texts.find((t) => t.str === "X1");
  const tRot = rot.extract.texts.find((t) => t.str === "X1");
  near(tRot.x, tBase.x, 0.5, "回転補正後のx");
  near(tRot.y, tBase.y, 0.5, "回転補正後のy");
};
