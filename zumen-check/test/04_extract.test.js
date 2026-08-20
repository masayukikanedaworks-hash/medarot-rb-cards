// コンテントストリームからの線分・テキスト抽出テスト
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
    (s) => Math.abs(s.y1 - 25) < 0.01 && Math.abs(s.y2 - 25) < 0.01 && Math.abs(s.x1 - s.x2) > 700
  );
  assert.ok(frame, "図枠のreが線分になること");

  // 破線指定の通り芯（X1: dパターン付きの縦線）
  const x1 = extract.segments.find(
    (s) => s.dashed && Math.abs(s.x1 - 150) < 0.01 && Math.abs(s.x2 - 150) < 0.01 && Math.abs(s.y2 - s.y1) > 400
  );
  assert.ok(x1, "dパターンの縦通り芯が dashed で抽出されること");

  // 曲線（バブル円）は curve フラグ付きで折れ線化される
  assert.ok(extract.segments.some((s) => s.curve), "曲線が折れ線として抽出されること");

  // 寸法線端点の黒ドット（塗り潰し円）: 段1=3点 / 段2=3点 / 縦列=2点
  assert.equal(extract.dots.length, 8, "黒ドットの数");
  assert.ok(
    extract.dots.some((d) => Math.abs(d.x - 150) < 0.3 && Math.abs(d.y - mk.ROW2_Y) < 0.3),
    "X1位置の黒ドットが拾えること"
  );

  // ラベルテキストの位置
  const tX1 = extract.texts.find((t) => t.str === "X1");
  assert.ok(tX1, "X1ラベルが読めること");
  near(tX1.x, 143, 0.5, "X1のx位置");
  near(tX1.y, 540, 0.5, "X1のy位置");

  // TJ 配列（カーニング付き）が 1 つのランに連結される
  const t6000 = extract.texts.filter((t) => t.str === "6000");
  assert.ok(t6000.length >= 2, "TJで書いた6000が1ランで読めること");

  // 90度回転した寸法文字（縦書き方向）も向き付きで抽出される
  const rot = extract.texts.find((t) => t.str === "6000" && Math.abs(t.ey - t.y) > Math.abs(t.ex - t.x));
  assert.ok(rot, "回転テキストが抽出されること");
  near(rot.x, mk.COL_X - 2.5, 0.5, "回転テキストのx位置");
};

exports.回転ページは表示向きに補正される = async () => {
  const base = await loadFirstPage(mk.makeBasicPdf());
  const rot = await loadFirstPage(mk.makeBasicPdf(null, { rotate: 90 }));
  assert.equal(rot.extract.width, 842, "回転後の表示幅");
  assert.equal(rot.extract.height, 595, "回転後の表示高さ");
  const tBase = base.extract.texts.find((t) => t.str === "X1");
  const tRot = rot.extract.texts.find((t) => t.str === "X1");
  assert.ok(tRot, "回転ページでもラベルが読めること");
  near(tRot.x, tBase.x, 0.5, "回転補正後のx");
  near(tRot.y, tBase.y, 0.5, "回転補正後のy");
  assert.equal(rot.extract.segments.length, base.extract.segments.length);
};
