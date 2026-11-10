// 分割図面（1つの建物を上下/左右に分けて複数ページに描いたもの）の認識と統合
"use strict";

const mk = require("./make_pdf");
const { loadFirstPage, analyze, assert } = require("./helpers");

// 建物全体: X1〜X4 / Y1〜Y5
function fullSpec() {
  const s = mk.makeSpec();
  s.vAxes = [
    { label: "X1", mm: 0 },
    { label: "X2", mm: 6000 },
    { label: "X3", mm: 11000 },
    { label: "X4", mm: 15000 },
  ];
  s.hAxes = [
    { label: "Y1", mm: 0 },
    { label: "Y2", mm: 3000 },
    { label: "Y3", mm: 6000 },
    { label: "Y4", mm: 9000 },
    { label: "Y5", mm: 12000 },
  ];
  s.splitsV0 = null;
  return s;
}

// 上下2分割（Y1〜Y3 / Y3〜Y5。Y3 が重なる）
function splitPair() {
  return mk.splitSpecs(fullSpec(), [[0, 2], [2, 4]], "h");
}

async function sidesOfPage(bytes, index) {
  const doc = await ZC.pdf.PDFDocument.load(bytes);
  const pages = await doc.getPages();
  const ex = await new ZC.content.ContentExtractor(doc).run(pages[index]);
  const det = ZC.axis.detect(ex);
  const dims = ZC.dims.extract(ex);
  return { page: index + 1, sides: ZC.sides.build(det, dims.entries) };
}

async function splitPages() {
  const bytes = mk.makeMultiPagePdf(splitPair());
  return [await sidesOfPage(bytes, 0), await sidesOfPage(bytes, 1)];
}

exports.複数ページのPDFを読める = async () => {
  const bytes = mk.makeMultiPagePdf(splitPair());
  const doc = await ZC.pdf.PDFDocument.load(bytes);
  const pages = await doc.getPages();
  assert.equal(pages.length, 2);
};

exports.上下に分割された図面だと分かる = async () => {
  const info = ZC.split.detect(await splitPages());
  assert.equal(info.split, true, info.reason);
  assert.equal(info.dir, "h", "横方向の芯で分かれている＝上下分割");
  assert.equal(info.name, "上下2分割");
  assert.deepEqual(info.parts.map((p) => p.page), [1, 2]);
  assert.deepEqual(info.parts[0].labels, ["Y1", "Y2", "Y3"]);
  assert.deepEqual(info.parts[1].labels, ["Y3", "Y4", "Y5"]);
  assert.deepEqual(info.overlap, ["Y3"], "重なっているページの境目が分かる");
  assert.deepEqual(info.union, ["Y1", "Y2", "Y3", "Y4", "Y5"]);
  assert.ok(/上下に2分割/.test(ZC.split.describe(info)), ZC.split.describe(info));
};

exports.左右に分割された図面だと分かる = async () => {
  const specs = mk.splitSpecs(fullSpec(), [[0, 1], [1, 3]], "v");
  const bytes = mk.makeMultiPagePdf(specs);
  const info = ZC.split.detect([await sidesOfPage(bytes, 0), await sidesOfPage(bytes, 1)]);
  assert.equal(info.split, true, info.reason);
  assert.equal(info.dir, "v");
  assert.equal(info.name, "左右2分割");
  assert.deepEqual(info.parts[0].labels, ["X1", "X2"]);
  assert.deepEqual(info.parts[1].labels, ["X2", "X3", "X4"]);
};

exports.同じ範囲の2ページは分割とみなさない = async () => {
  const bytes = mk.makeMultiPagePdf([fullSpec(), fullSpec()]);
  const info = ZC.split.detect([await sidesOfPage(bytes, 0), await sidesOfPage(bytes, 1)]);
  assert.equal(info.split, false);
  assert.ok(/ほぼ同じ/.test(info.reason), info.reason);
};

exports.ページが1つだけなら分割ではない = async () => {
  const a = await analyze(mk.makeBasicPdf());
  const info = ZC.split.detect([{ page: 1, sides: a.sides }]);
  assert.equal(info.split, false);
};

exports.分割されたページをまとめて1枚ぶんにする = async () => {
  const pages = await splitPages();
  const merged = ZC.split.merge(pages);
  // 左辺: 2ページ分の横芯がすべて並ぶ
  assert.deepEqual(merged.left.axes.map((a) => a.label), ["Y1", "Y2", "Y3", "Y4", "Y5"]);
  assert.deepEqual(
    merged.left.spans.map((s) => s.from + "~" + s.to + ":" + s.value),
    ["Y1~Y2:3000", "Y2~Y3:3000", "Y3~Y4:3000", "Y4~Y5:3000"]
  );
  // 全体寸法は、通しで書かれていなければ区間の合計として出す（記載値の合計）
  assert.equal(merged.left.total.value, 12000);
  assert.equal(merged.left.total.summed, true);
  // 上辺: どちらのページにもある縦芯はそのまま
  assert.deepEqual(merged.top.axes.map((a) => a.label), ["X1", "X2", "X3", "X4"]);
  assert.equal(merged.top.spans.find((s) => s.from === "X1").value, 6000);
  assert.deepEqual(merged.conflicts, [], "ページ間で食い違いなし");
};

// ページが2本以上重なっていれば同じ区間が両方のページに出る。
// そこで記載値が違えば図面自体の不整合なので知らせる。
exports.ページ間で寸法が食い違えば知らせる = async () => {
  // Y1〜Y3 と Y2〜Y5（Y2〜Y3 が両方のページに載る）
  const specs = mk.splitSpecs(fullSpec(), [[0, 2], [1, 4]], "h");
  specs[1].dims = { h: ["9999"] }; // 2ページ目の左辺 Y2〜Y3 だけ書き換える
  const bytes = mk.makeMultiPagePdf(specs);
  const pages = [await sidesOfPage(bytes, 0), await sidesOfPage(bytes, 1)];
  assert.equal(pages[0].sides.left.spans.find((x) => x.from === "Y2").value, 3000);
  assert.equal(pages[1].sides.left.spans.find((x) => x.from === "Y2").value, 9999);
  const merged = ZC.split.merge(pages);
  const c = merged.conflicts.find((x) => x.item === "Y2~Y3" && x.side === "left");
  assert.ok(c, "食い違いを拾う: " + JSON.stringify(merged.conflicts));
  assert.deepEqual(c.values.slice().sort((a, b) => a - b), [3000, 9999], JSON.stringify(c));
  assert.deepEqual(c.tags, ["1ページ目", "2ページ目"], JSON.stringify(c));
};

// 重なりが2本以上あるページでも分割と分かる
exports.重なりが広くても分割と分かる = async () => {
  const bytes = mk.makeMultiPagePdf(mk.splitSpecs(fullSpec(), [[0, 2], [1, 4]], "h"));
  const info = ZC.split.detect([await sidesOfPage(bytes, 0), await sidesOfPage(bytes, 1)]);
  assert.equal(info.split, true, info.reason);
  assert.deepEqual(info.overlap, ["Y2", "Y3"]);
};

// 分割したものをまとめれば、分割していない同じ建物の図面と一致する
exports.まとめた結果は分割前の図面と一致する = async () => {
  const merged = ZC.split.merge(await splitPages());
  const whole = await analyze(mk.makeBasicPdf(fullSpec()));
  const r = ZC.compare.compare(
    { sides: ZC.split.byDirection(merged), name: "分割" },
    { sides: ZC.split.byDirection(whole.sides), name: "全体" },
    { tol: 1, checks: { labels: true, spacing: true, total: true } }
  );
  const bad = r.rows.filter((x) => x.status !== "OK");
  assert.deepEqual(bad.map((x) => x.side + " " + x.check + " " + x.item), [], JSON.stringify(bad, null, 1));
  assert.ok(r.summary.ok > 10, "照合できた項目数: " + r.summary.ok);
};

// 1ページだけで照合すると、載っていない範囲が差異として出てしまう
exports.片方のページだけで照合すると足りない分が差異になる = async () => {
  const pages = await splitPages();
  const whole = await analyze(mk.makeBasicPdf(fullSpec()));
  const r = ZC.compare.compare(
    { sides: ZC.split.byDirection(pages[0].sides), name: "1ページ目" },
    { sides: ZC.split.byDirection(whole.sides), name: "全体" },
    { tol: 1, checks: { labels: true, spacing: true, total: true } }
  );
  assert.ok(r.summary.ng > 0, "Y4/Y5 が無いので差異が出る");
};
