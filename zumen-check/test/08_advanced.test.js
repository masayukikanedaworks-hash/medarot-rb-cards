// xrefストリーム + ObjStm + Type0(Identity-H) + Form XObject 構成のPDFでも同じ結果になること
"use strict";

const mk = require("./make_pdf");
const { detectAxes, onAxes, near, assert } = require("./helpers");

exports.高機能構成のPDFでも同じ検出結果 = async () => {
  const spec = mk.makeSpec();
  const { det, extract } = await detectAxes(mk.makeAdvancedPdf(spec));
  const on = onAxes(det);
  const expected = mk.axisPositions(spec);

  assert.deepEqual(on.v.map((a) => a.label), ["X1", "X2", "X3"]);
  on.v.forEach((a, i) => near(a.pos, expected.v[i].pos, 0.2, "縦芯" + (i + 1)));
  assert.deepEqual(on.h.map((a) => a.label), ["Y1", "Y2"]);
  on.h.forEach((a, i) => near(a.pos, expected.h[i].pos, 0.2, "横芯" + (i + 1)));

  // ToUnicode 経由で寸法値も読める
  const samples = ZC.scale.collectDimSamples(on.v, on.h, extract.texts);
  const inf = ZC.scale.infer(samples);
  assert.equal(inf.den, 100);
};

exports.基本構成と高機能構成の照合が一致 = async () => {
  const { sideOf } = require("./helpers");
  const base = await sideOf(mk.makeBasicPdf(), "基準");
  const cmp = await sideOf(mk.makeAdvancedPdf(), "比較");
  const r = ZC.compare.compare(base, cmp, { tol: 1, checks: { labels: true, spacing: true, total: true, dims: false } });
  assert.equal(r.summary.ng, 0, JSON.stringify(r.rows.filter((x) => x.status !== "OK")));
  assert.equal(r.summary.warn, 0);
};
