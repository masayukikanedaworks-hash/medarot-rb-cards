// 縮尺推定のテスト
"use strict";

const mk = require("./make_pdf");
const { detectAxes, onAxes, near, assert } = require("./helpers");

exports.寸法値から縮尺を推定 = async () => {
  const { extract, det } = await detectAxes(mk.makeBasicPdf());
  const on = onAxes(det);
  const samples = ZC.scale.collectDimSamples(on.v, on.h, extract.texts);
  assert.ok(samples.length >= 3, "寸法サンプルが3件以上（実際: " + samples.length + "）");
  const inf = ZC.scale.infer(samples);
  assert.equal(inf.den, 100, "1/100 に推定されること");
  assert.equal(inf.snapped, true);
  near(inf.mmPerPt * 170.0787, 6000, 0.5, "6000mmスパンの換算");
};

exports.寸法値が無ければ推定不能 = () => {
  const inf = ZC.scale.infer([]);
  assert.equal(inf.den, null);
};

exports.異常値が混ざっても多数決で決まる = () => {
  const samples = [
    { mmPerPt: 35.2778 },
    { mmPerPt: 35.28 },
    { mmPerPt: 35.27 },
    { mmPerPt: 70.55 }, // 別スパンの誤対応など
  ];
  const inf = ZC.scale.infer(samples);
  assert.equal(inf.den, 100);
};
