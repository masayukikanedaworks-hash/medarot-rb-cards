// xrefストリーム + ObjStm + Type0(Identity-H) + Form XObject 構成のPDFでも同じ結果になること
"use strict";

const mk = require("./make_pdf");
const { analyze, labels, sideOf, spansOf, assert } = require("./helpers");

exports.高機能構成のPDFでも同じ拾い出し結果 = async () => {
  const basic = await analyze(mk.makeBasicPdf());
  const adv = await analyze(mk.makeAdvancedPdf());
  assert.deepEqual(labels(adv.det, "v"), ["X1", "X2", "X3"]);
  assert.deepEqual(labels(adv.det, "h"), ["Y1", "Y2"]);
  for (const key of ["top", "right", "bottom", "left"]) {
    assert.deepEqual(spansOf(adv.sides, key), spansOf(basic.sides, key), key + "の区間");
  }
  assert.equal(ZC.sides.formatText(adv.sides), ZC.sides.formatText(basic.sides));
};

exports.基本構成と高機能構成の照合が一致 = async () => {
  const base = await sideOf(mk.makeBasicPdf(), "基準");
  const cmp = await sideOf(mk.makeAdvancedPdf(), "比較");
  const r = ZC.compare.compare(
    { sides: base.sides, name: "基準" },
    { sides: cmp.sides, name: "比較" },
    { tol: 1, checks: { labels: true, spacing: true, total: true } }
  );
  assert.equal(r.summary.ng, 0, JSON.stringify(r.rows.filter((x) => x.status !== "OK")));
  assert.equal(r.summary.warn, 0);
};
