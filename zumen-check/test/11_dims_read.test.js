// 記載寸法の読み取り（黒ドット間の直線の上の数字）のテスト
"use strict";

const mk = require("./make_pdf");
const { loadFirstPage, detectAxes, onAxes, sideOf, near, assert } = require("./helpers");

const CHECKS = { labels: true, spacing: true, total: true, dims: false };

exports.ドットと記載寸法の抽出 = async () => {
  const spec = mk.makeSpec();
  const { extract } = await loadFirstPage(mk.makeBasicPdf(spec));
  const dims = ZC.dims.extract(extract);
  assert.equal(dims.dots.length, 8, "ドット数（段1=3, 段2=3, 縦列=2）");
  assert.equal(dims.entries.length, 5, "記載寸法の区間数: " + JSON.stringify(dims.entries.map((e) => e.value)));
  const values = dims.entries.map((e) => e.value).sort((a, b) => a - b);
  assert.deepEqual(values, [2730.5, 3269.5, 5000, 6000, 6000], "小数を含む記載値が読めること");
};

exports.通り芯間は単一記載を優先し分割は合計する = async () => {
  const spec = mk.makeSpec();
  const { extract } = await loadFirstPage(mk.makeBasicPdf(spec));
  const dims = ZC.dims.extract(extract);
  const pos = mk.axisPositions(spec);
  // X1〜X2: 段2の単一記載 6000 を採用（段1の 2730.5+3269.5 と一致 → conflict なし）
  const v12 = ZC.dims.spanValue(dims.entries, "v", pos.v[0].pos, pos.v[1].pos);
  assert.equal(v12.value, 6000);
  assert.equal(v12.parts.length, 1);
  assert.equal(v12.conflict, false);
  // 分割点までの区間は分割値そのもの
  const split1 = ZC.dims.spanValue(dims.entries, "v", pos.v[0].pos, pos.v[0].pos + mk.toPt(spec, 2730.5));
  assert.equal(split1.value, 2730.5);
  // 全体 X1〜X3 は段2のチェーン合計
  const v13 = ZC.dims.spanValue(dims.entries, "v", pos.v[0].pos, pos.v[2].pos);
  assert.equal(v13.value, 11000);
  assert.deepEqual(v13.parts, [6000, 5000]);
};

exports.分割記載しか無い区間は合計で読む = async () => {
  const spec = mk.makeSpec();
  spec.noRow2 = true; // 段1（2730.5 + 3269.5）だけにする
  const { extract } = await loadFirstPage(mk.makeBasicPdf(spec));
  const dims = ZC.dims.extract(extract);
  const pos = mk.axisPositions(spec);
  const v12 = ZC.dims.spanValue(dims.entries, "v", pos.v[0].pos, pos.v[1].pos);
  assert.ok(v12, "分割チェーンで読めること");
  assert.equal(v12.value, 6000);
  assert.deepEqual(v12.parts, [2730.5, 3269.5]);
  // 段が無い X2〜X3 は記載なし
  const v23 = ZC.dims.spanValue(dims.entries, "v", pos.v[1].pos, pos.v[2].pos);
  assert.equal(v23, null);
};

exports.寸法段どうしの食い違いはconflictになる = async () => {
  const spec = mk.makeSpec();
  spec.dims.v = ["6100", null]; // 段2を6100に（段1の合計6000と食い違い）
  const { extract } = await loadFirstPage(mk.makeBasicPdf(spec));
  const dims = ZC.dims.extract(extract);
  const pos = mk.axisPositions(spec);
  const v12 = ZC.dims.spanValue(dims.entries, "v", pos.v[0].pos, pos.v[1].pos);
  assert.equal(v12.value, 6100, "単一記載を優先");
  assert.equal(v12.conflict, true, "分割合計との食い違いを検出");
};

exports.小数点付きの符号も拾える = async () => {
  const spec = mk.makeSpec();
  spec.vAxes.splice(1, 0, { label: "X1.5", mm: 3000 });
  spec.splitsV0 = null;
  const { det } = await detectAxes(mk.makeBasicPdf(spec));
  const on = onAxes(det);
  assert.deepEqual(on.v.map((a) => a.label), ["X1", "X1.5", "X2", "X3"]);
  const expected = mk.axisPositions(spec);
  on.v.forEach((a, i) => near(a.pos, expected.v[i].pos, 0.15));
};

exports.小数符号の図面どうしの照合 = async () => {
  const spec = mk.makeSpec();
  spec.vAxes.splice(1, 0, { label: "X1.5", mm: 3000 });
  spec.splitsV0 = null;
  const base = await sideOf(mk.makeBasicPdf(spec), "基準");
  const cmp = await sideOf(mk.makeBasicPdf(spec), "比較");
  const r = ZC.compare.compare(base, cmp, { tol: 1, checks: CHECKS });
  assert.equal(r.summary.ng, 0, JSON.stringify(r.rows.filter((x) => x.status !== "OK")));
  const sp = r.rows.find((x) => x.check === "芯々寸法" && x.item === "X1〜X1.5");
  assert.ok(sp, "小数符号の区間が照合される");
  assert.equal(sp.base, "3000.0");
};
