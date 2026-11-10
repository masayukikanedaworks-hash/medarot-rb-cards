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

// --- 照合の単位の自動選択 ---------------------------------------------------

// 平面図は4辺すべてに符号を書くが、構造図は下辺と左辺にしか書かない。
// 辺ごとに照合すると書き方の違いだけで大量にNGが出るので、方向ごとに切り替える。
exports.符号を書く辺が違えば方向ごとを選ぶ = async () => {
  const plan = mk.makeSpec(); // 4辺すべてに符号
  const stru = mk.makeSpec();
  stru.vAxes = stru.vAxes.map((a) => Object.assign({}, a, { sides: ["bottom"] }));
  stru.hAxes = stru.hAxes.map((a) => Object.assign({}, a, { sides: ["left"] }));
  const a = await analyze(mk.makeBasicPdf(plan));
  const b = await analyze(mk.makeBasicPdf(stru));
  const pick = ZC.split.pickUnit(a.sides, b.sides);
  assert.equal(pick.unit, "dir", pick.reason);
  assert.ok(pick.diffs.some((d) => d.side === "top"), JSON.stringify(pick.diffs));
  assert.ok(/符号を書いている辺/.test(pick.reason), pick.reason);

  // 辺ごとだと書き方の違いでNGが大量に出るが、方向ごとなら出ない
  const opts = { tol: 1, checks: { labels: true, spacing: true, total: true } };
  const bySide = ZC.compare.compare({ sides: a.sides }, { sides: b.sides }, opts);
  const byDir = ZC.compare.compare(
    { sides: ZC.split.byDirection(a.sides) },
    { sides: ZC.split.byDirection(b.sides) },
    opts
  );
  assert.ok(bySide.summary.ng > 0, "辺ごとだと差異が出てしまう");
  assert.equal(byDir.summary.ng, 0, "方向ごとなら差異なし: " +
    JSON.stringify(byDir.rows.filter((r) => r.status === "NG")));
};

exports.同じ辺に符号を書いていれば辺ごとを選ぶ = async () => {
  const a = await analyze(mk.makeBasicPdf());
  const b = await analyze(mk.makeBasicPdf());
  const pick = ZC.split.pickUnit(a.sides, b.sides);
  assert.equal(pick.unit, "side", pick.reason);
  assert.deepEqual(pick.diffs, []);
};

// 判定の行は「どの辺の話か」を持つ。これが無いと図上で、上辺の判定で
// 下辺の符号まで塗ってしまう
exports.判定の行はどの辺かを持つ = async () => {
  const a = await analyze(mk.makeBasicPdf());
  const spec = mk.makeSpec();
  spec.vAxes[1].sides = ["bottom"]; // X2 を上辺から消す
  const b = await analyze(mk.makeBasicPdf(spec));
  const r = ZC.compare.compare({ sides: a.sides }, { sides: b.sides },
    { tol: 1, checks: { labels: true, spacing: true, total: true } });
  const ng = r.rows.find((x) => x.status === "NG" && x.check === "通り芯" && x.item === "X2");
  assert.ok(ng, "上辺で X2 が見つからない差異: " + JSON.stringify(r.rows.filter(x=>x.status==="NG")));
  assert.equal(ng.sideKey, "top", "どの辺の判定かを持つ");
  // 塗る対象はその辺の符号だけ（X2 の芯は上辺・下辺の両方にバブルを持つ）
  const ax = ng.refs.b[0];
  assert.ok(ax.bubbles.length >= 2, "芯は両端に符号を持つ: " + ax.bubbles.length);
  const onSide = ax.bubbles.filter((x) => x.side === ng.sideKey);
  assert.equal(onSide.length, 1, "塗るのは上辺の符号1つだけ");
};
