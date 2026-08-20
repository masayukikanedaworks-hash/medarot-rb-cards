// 通り芯検出のテスト
"use strict";

const mk = require("./make_pdf");
const { detectAxes, onAxes, near, assert } = require("./helpers");

exports.通り芯の検出と符号割り当て = async () => {
  const spec = mk.makeSpec();
  const { det } = await detectAxes(mk.makeBasicPdf(spec));
  const on = onAxes(det);
  const expected = mk.axisPositions(spec);

  // 既定ONの縦芯は X1/X2/X3 のみ（壁二重線・図枠は既定OFF）
  assert.deepEqual(on.v.map((a) => a.label), ["X1", "X2", "X3"]);
  on.v.forEach((a, i) => near(a.pos, expected.v[i].pos, 0.15, "縦芯" + (i + 1) + "の位置"));

  assert.deepEqual(on.h.map((a) => a.label), ["Y1", "Y2"]);
  on.h.forEach((a, i) => near(a.pos, expected.h[i].pos, 0.15, "横芯" + (i + 1) + "の位置"));

  // 分割描画（dパターン無し）の X3 も鎖線相当と判定される
  const x3 = on.v[2];
  assert.equal(x3.dashed, true, "分割描画の芯が鎖線扱いになること");
  assert.ok(x3.pieces >= 4);

  // 図枠は frameSuspect フラグ付きで既定OFF
  const frames = det.v.filter((a) => a.frameSuspect);
  assert.ok(frames.length >= 2, "縦の図枠線が候補に挙がること");
  assert.ok(frames.every((a) => !a.defaultOn), "図枠は既定OFF");

  // 壁の二重線（X1±5.5pt の実線）は候補に挙がるが既定OFF
  const walls = det.v.filter((a) => Math.abs(a.pos - (expected.v[0].pos - 5.5)) < 0.2 || Math.abs(a.pos - (expected.v[0].pos + 5.5)) < 0.2);
  assert.equal(walls.length, 2, "壁線が候補として検出されること");
  assert.ok(walls.every((a) => !a.defaultOn && !a.label), "壁線は既定OFFで符号なし");

  // 横の寸法線（y=97 の実線, X1〜X3で長い）も候補だが既定OFF
  const dimLine = det.h.find((a) => Math.abs(a.pos - mk.ROW2_Y) < 0.2);
  assert.ok(dimLine, "寸法線が候補として検出されること");
  assert.equal(dimLine.defaultOn, false);

  // 縦向きの寸法線（x=95）も候補だが既定OFFで符号は付かない
  const dimCol = det.v.find((a) => Math.abs(a.pos - mk.COL_X) < 0.2);
  if (dimCol) {
    assert.equal(dimCol.defaultOn, false);
    assert.equal(dimCol.label, null);
  }
};

exports.回転ページでも同じ検出結果 = async () => {
  const spec = mk.makeSpec();
  const { det } = await detectAxes(mk.makeBasicPdf(spec, { rotate: 90 }));
  const on = onAxes(det);
  const expected = mk.axisPositions(spec);
  assert.deepEqual(on.v.map((a) => a.label), ["X1", "X2", "X3"]);
  on.v.forEach((a, i) => near(a.pos, expected.v[i].pos, 0.15));
  assert.deepEqual(on.h.map((a) => a.label), ["Y1", "Y2"]);
};
