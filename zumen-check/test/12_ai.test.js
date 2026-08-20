// AI解析の突き合わせロジック（ZC.ai）のテスト。API呼び出しはしない純粋部分のみ。
"use strict";

const mk = require("./make_pdf");
const { analyze, assert } = require("./helpers");

function aiResult(sides) {
  return { sides, notes: "" };
}

exports.AIの応答を正規化する = () => {
  const norm = ZC.ai.normalize(
    aiResult({
      top: { axes: ["ｘ１", "X2"], spans: [{ from: "ｘ１", to: "X2", value: 6000, parts: [2730.5, 3269.5] }] },
      right: { axes: ["Y1"], spans: [] },
      // bottom / left が欠けていても落ちない
    })
  );
  assert.deepEqual(norm.top.axes, ["X1", "X2"], "全角の符号が半角に正規化される");
  assert.equal(norm.top.spans[0].from, "X1");
  assert.deepEqual(norm.top.spans[0].parts, [2730.5, 3269.5]);
  assert.deepEqual(norm.bottom, { axes: [], spans: [] }, "欠けている辺は空で埋める");
};

exports.自動読み取りとAIが一致する場合 = async () => {
  const { sides } = await analyze(mk.makeBasicPdf());
  const ai = ZC.ai.normalize(
    aiResult({
      top: { axes: ["X1", "X2", "X3"], spans: [
        { from: "X1", to: "X2", value: 6000, parts: [] },
        { from: "X2", to: "X3", value: 5000, parts: [] },
      ] },
      bottom: { axes: ["X1", "X2", "X3"], spans: [
        { from: "X1", to: "X2", value: 6000, parts: [2730.5, 3269.5] },
        { from: "X2", to: "X3", value: 5000, parts: [] },
      ] },
      left: { axes: ["Y1", "Y2"], spans: [{ from: "Y1", to: "Y2", value: 6000, parts: [] }] },
      right: { axes: ["Y1", "Y2"], spans: [{ from: "Y1", to: "Y2", value: 6000, parts: [] }] },
    })
  );
  const d = ZC.ai.diff(sides, ai, 1);
  assert.equal(d.summary.differ, 0, JSON.stringify(d.rows.filter((r) => r.status !== "一致")));
  assert.equal(d.summary.localOnly, 0);
  assert.equal(d.summary.aiOnly, 0);
  assert.ok(d.summary.same > 0);
};

exports.値の相違とAIのみの通り芯を検出 = async () => {
  const { sides } = await analyze(mk.makeBasicPdf());
  const ai = ZC.ai.normalize(
    aiResult({
      top: { axes: ["X1", "X2", "X2.5", "X3"], spans: [
        { from: "X1", to: "X2", value: 6020, parts: [] }, // 値が違う
        { from: "X2", to: "X2.5", value: 2000, parts: [] }, // AIだけが読んだ区間
        { from: "X2.5", to: "X3", value: 3000, parts: [] },
      ] },
      bottom: { axes: [], spans: [] },
      left: { axes: [], spans: [] },
      right: { axes: [], spans: [] },
    })
  );
  const d = ZC.ai.diff(sides, ai, 1);
  const differ = d.rows.filter((r) => r.status === "相違");
  assert.ok(differ.some((r) => r.item === "X1~X2" && r.local === "6000" && r.ai === "6020"), JSON.stringify(differ));
  const aiOnly = d.rows.filter((r) => r.status === "AIのみ");
  assert.ok(aiOnly.some((r) => r.kind === "通り芯" && r.item === "X2.5"), "AIだけが拾った通り芯");
  const localOnly = d.rows.filter((r) => r.status === "自動のみ");
  assert.ok(localOnly.some((r) => r.side === "下辺"), "AIが空の辺は自動のみになる");
};

exports.許容差の範囲内は一致とみなす = async () => {
  const { sides } = await analyze(mk.makeBasicPdf());
  const ai = ZC.ai.normalize(
    aiResult({
      top: { axes: ["X1", "X2", "X3"], spans: [
        { from: "X1", to: "X2", value: 6000.5, parts: [] },
        { from: "X2", to: "X3", value: 5000, parts: [] },
      ] },
      bottom: { axes: [], spans: [] }, left: { axes: [], spans: [] }, right: { axes: [], spans: [] },
    })
  );
  assert.equal(ZC.ai.diff(sides, ai, 1).rows.filter((r) => r.item === "X1~X2" && r.status === "相違").length, 0);
  assert.equal(ZC.ai.diff(sides, ai, 0.2).rows.filter((r) => r.item === "X1~X2" && r.status === "相違").length, 1);
};

exports.AIの結果を拾い出し表記にする = () => {
  const ai = ZC.ai.normalize(
    aiResult({
      top: { axes: ["X1", "X2"], spans: [{ from: "X1", to: "X2", value: 5917, parts: [2730.5, 3186.5] }] },
      bottom: { axes: [], spans: [] }, left: { axes: [], spans: [] }, right: { axes: [], spans: [] },
    })
  );
  const txt = ZC.ai.formatText(ai);
  assert.ok(txt.includes("上辺"), txt);
  assert.ok(txt.includes("X1~X2：5917（2730.5+3186.5）"), txt);
  assert.ok(txt.includes("（通り芯なし）"), "空の辺も表示される");
};

exports.base64変換 = () => {
  const prev = globalThis.btoa;
  globalThis.btoa = (s) => Buffer.from(s, "latin1").toString("base64");
  try {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
    assert.equal(ZC.ai.toBase64(bytes), "JVBERg==");
    const big = new Uint8Array(70000).fill(65); // 分割処理の確認
    assert.equal(ZC.ai.toBase64(big), Buffer.alloc(70000, 65).toString("base64"));
  } finally {
    globalThis.btoa = prev;
  }
};
