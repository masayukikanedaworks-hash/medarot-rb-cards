// テスト用の合成ベクターPDF生成器
// 実図面に合わせ、通り芯は上下左右の4辺すべてに「円（バブル）で囲まれた符号」を持ち、
// 各辺に黒ドット付きの寸法線を持つ簡易平面図を、2系統のPDF構造で書き出す:
//   makeBasicPdf    … クラシック xref 表 + Type1(WinAnsi) フォント
//   makeAdvancedPdf … xref ストリーム(Predictor 12) + ObjStm + Type0(Identity-H)+ToUnicode + Form XObject
"use strict";

const zlib = require("node:zlib");

const PT_PER_MM_PAPER = 72 / 25.4; // 紙上mm → pt（値の設計にのみ使用。ツール側は縮尺を使わない）
const X0 = 150; // X1 の紙上位置 pt
const Y0 = 150; // Y1 の紙上位置 pt

// レイアウト定数（テストからも参照する）
const V_FROM = 52;   // 縦芯の下端
const V_TO = 505;    // 縦芯の上端
const H_FROM = 84;   // 横芯の左端
const H_TO = 766;    // 横芯の右端
const BOTTOM_SPAN_Y = 62;  // 下辺: 通り芯間寸法の段
const BOTTOM_SPLIT_Y = 76; // 下辺: 分割寸法の段
const TOP_SPAN_Y = 494;    // 上辺: 通り芯間寸法の段
const LEFT_COL_X = 96;     // 左辺: 寸法線
const RIGHT_COL_X = 754;   // 右辺: 寸法線
const BUBBLE_R = 9;

function makeSpec() {
  return {
    den: 100, // 値の設計用（1/100相当の紙上配置にする）
    vAxes: [
      { label: "X1", mm: 0 },
      { label: "X2", mm: 6000 },
      { label: "X3", mm: 11000, pieces: true }, // 短い線分の連なりで鎖線を模す
    ],
    hAxes: [
      { label: "Y1", mm: 0 },
      { label: "Y2", mm: 6000 },
    ],
    // vAxes/hAxes の要素には次を指定できる:
    //   from/to  … 芯線の範囲（省略時は全長）。実図面の部分的な通り芯を模す
    //   sides    … 符号バブルを置く辺（省略時は両端）。例: ["top"]
    dims: {}, // {v:[...], h:[...]} 下辺/左辺の通り芯間寸法の注記上書き
    dimsTop: null, // [...] 上辺の注記上書き（省略時は下辺と同じ値）
    dimsRight: null, // [...] 右辺の注記上書き（省略時は左辺と同じ値）
    splitsV0: [2730.5, 3269.5], // 下辺: X1〜X2 の分割寸法。null で分割段なし
    noRow2: false, // true で下辺の通り芯間寸法の段を省略（分割合計の検証用）
    noBubbles: false, // true で符号の円囲みを省略（円必須の検証用）
    dots: true, // false で黒ドット無しの旧式注記（フォールバック検証用）
    // 右下の小さなキープラン（本図とは別の図）。{labels:{v:[],h:[]}} を与えると
    // 本図より小さい符号バブル付きの縮小図を描く。拾い出しから除外されるべきもの。
    keyPlan: null,
  };
}

function toPt(spec, mm) {
  return (mm / spec.den) * PT_PER_MM_PAPER;
}

// テストの期待値計算用: 各芯の紙上位置
function axisPositions(spec) {
  return {
    v: spec.vAxes.map((a) => ({ label: a.label, pos: X0 + toPt(spec, a.mm) })),
    h: spec.hAxes.map((a) => ({ label: a.label, pos: Y0 + toPt(spec, a.mm) })),
  };
}

function fmt(n) {
  return String(Math.round(n * 10000) / 10000);
}

function fmtDim(mm) {
  return String(Math.round(mm * 10) / 10);
}

// 円（塗り potFill=true なら塗り潰し）
function circleOps(cx, cy, r, fill) {
  const k = r * 0.5523;
  return (
    `${fmt(cx + r)} ${fmt(cy)} m ` +
    `${fmt(cx + r)} ${fmt(cy + k)} ${fmt(cx + k)} ${fmt(cy + r)} ${fmt(cx)} ${fmt(cy + r)} c ` +
    `${fmt(cx - k)} ${fmt(cy + r)} ${fmt(cx - r)} ${fmt(cy + k)} ${fmt(cx - r)} ${fmt(cy)} c ` +
    `${fmt(cx - r)} ${fmt(cy - k)} ${fmt(cx - k)} ${fmt(cy - r)} ${fmt(cx)} ${fmt(cy - r)} c ` +
    `${fmt(cx + k)} ${fmt(cy - r)} ${fmt(cx + r)} ${fmt(cy - k)} ${fmt(cx + r)} ${fmt(cy)} c ` +
    (fill ? "f" : "S")
  );
}

// 図の描画オペレータ列を作る。textEnc は文字列→表示オペランドの変換
function drawingOps(spec, textEnc, useTJ) {
  const pos = axisPositions(spec);
  const ops = [];
  const texts = [];
  const textAt = (x, y, str, tj) => {
    if (tj && useTJ && str.length > 2) {
      texts.push(`1 0 0 1 ${fmt(x)} ${fmt(y)} Tm [${textEnc(str.slice(0, 2))} -20 ${textEnc(str.slice(2))}] TJ`);
    } else {
      texts.push(`1 0 0 1 ${fmt(x)} ${fmt(y)} Tm ${textEnc(str)} Tj`);
    }
  };
  const textRotAt = (x, y, str) => {
    texts.push(`0 1 -1 0 ${fmt(x)} ${fmt(y)} Tm ${textEnc(str)} Tj`);
  };

  // 図枠とタイトル欄
  ops.push("0.7 w [] 0 d");
  ops.push("20 20 802 555 re S");
  ops.push("650 24 168 36 re S");
  ops.push("650 42 m 818 42 l S");
  ops.push("710 24 m 710 42 l S");

  // 壁の二重線（X1沿い・長め実線 → 誤検出候補になるが既定OFFのはず）
  ops.push("1 w");
  ops.push(`${fmt(pos.v[0].pos - 5.5)} 150 m ${fmt(pos.v[0].pos - 5.5)} 350 l S`);
  ops.push(`${fmt(pos.v[0].pos + 5.5)} 150 m ${fmt(pos.v[0].pos + 5.5)} 350 l S`);

  // ノイズ: 斜線・ドア円弧・短い破線
  ops.push("0.4 w");
  ops.push("180 120 m 300 170 l S");
  ops.push("540 260 m 540 282.09 522.09 300 500 300 c S");
  ops.push("[3 3] 0 d 600 260 m 600 320 l S [] 0 d");

  // 通り芯（縦）
  for (const a of pos.v) {
    const specAx = spec.vAxes[pos.v.indexOf(a)];
    const from = specAx.from != null ? specAx.from : V_FROM;
    const to = specAx.to != null ? specAx.to : V_TO;
    ops.push("0.5 w");
    if (specAx.pieces) {
      ops.push("[] 0 d");
      for (let y = from; y < to; y += 23.5) {
        const y2 = Math.min(y + 18, to);
        ops.push(`${fmt(a.pos)} ${fmt(y)} m ${fmt(a.pos)} ${fmt(y2)} l S`);
      }
    } else {
      ops.push("[6 3 1.5 3] 0 d");
      ops.push(`${fmt(a.pos)} ${fmt(from)} m ${fmt(a.pos)} ${fmt(to)} l S`);
      ops.push("[] 0 d");
    }
  }
  // 通り芯（横）
  for (const a of pos.h) {
    const specAx = spec.hAxes[pos.h.indexOf(a)];
    const from = specAx.from != null ? specAx.from : H_FROM;
    const to = specAx.to != null ? specAx.to : H_TO;
    ops.push("0.5 w [6 3 1.5 3] 0 d");
    ops.push(`${fmt(from)} ${fmt(a.pos)} m ${fmt(to)} ${fmt(a.pos)} l S`);
    ops.push("[] 0 d");
  }

  // 符号（円囲み・上下/左右の両端）
  ops.push("0.5 w");
  const label = (cx, cy, str) => {
    if (!spec.noBubbles) ops.push(circleOps(cx, cy, BUBBLE_R, false));
    textAt(cx - str.length * 2.5, cy - 3.5, str, false);
  };
  for (const a of pos.v) {
    const sides = spec.vAxes[pos.v.indexOf(a)].sides || ["bottom", "top"];
    if (sides.includes("bottom")) label(a.pos, 40, a.label);
    if (sides.includes("top")) label(a.pos, 516, a.label);
  }
  for (const a of pos.h) {
    const sides = spec.hAxes[pos.h.indexOf(a)].sides || ["left", "right"];
    if (sides.includes("left")) label(72, a.pos, a.label);
    if (sides.includes("right")) label(780, a.pos, a.label);
  }

  // ---- 寸法（4辺） ----
  if (spec.dots) {
    ops.push("0.4 w [] 0 d");
    const dot = (x, y) => ops.push(circleOps(x, y, 0.9, true));
    // 横向きの寸法線1段（points: x座標列 / values: 各区間の注記）
    const hDimRow = (rowY, points, values, tjFirst) => {
      ops.push(`${fmt(points[0])} ${fmt(rowY)} m ${fmt(points[points.length - 1])} ${fmt(rowY)} l S`);
      for (const p of points) dot(p, rowY);
      for (let i = 0; i + 1 < points.length; i++) {
        const str = values[i];
        if (str == null) continue;
        const mid = (points[i] + points[i + 1]) / 2;
        textAt(mid - str.length * 2.5, rowY + 1.5, str, tjFirst && i === 0);
      }
    };
    // 縦向きの寸法線1列（数字は90度回転で線の左）
    const vDimCol = (colX, points, values) => {
      ops.push(`${fmt(colX)} ${fmt(points[0])} m ${fmt(colX)} ${fmt(points[points.length - 1])} l S`);
      for (const p of points) dot(colX, p);
      for (let i = 0; i + 1 < points.length; i++) {
        const str = values[i];
        if (str == null) continue;
        const mid = (points[i] + points[i + 1]) / 2;
        textRotAt(colX - 2.5, mid - str.length * 2.5, str);
      }
    };
    // 辺ごとに、その辺に符号がある芯だけを寸法線の点にする
    const forSide = (axes, positions, side, defSides) =>
      axes
        .map((ax, i) => ({ ax, pos: positions[i].pos }))
        .filter((o) => (o.ax.sides || defSides).includes(side));
    const valuesOf = (list, override) => {
      const out = [];
      for (let i = 0; i + 1 < list.length; i++) {
        out.push(override && override[i] != null ? override[i] : fmtDim(list[i + 1].ax.mm - list[i].ax.mm));
      }
      return out;
    };
    const vBottom = forSide(spec.vAxes, pos.v, "bottom", ["bottom", "top"]);
    const vTop = forSide(spec.vAxes, pos.v, "top", ["bottom", "top"]);
    const hLeft = forSide(spec.hAxes, pos.h, "left", ["left", "right"]);
    const hRight = forSide(spec.hAxes, pos.h, "right", ["left", "right"]);
    const vPts = vBottom.map((o) => o.pos);
    const vValues = valuesOf(vBottom, spec.dims.v);
    const hPts = hLeft.map((o) => o.pos);
    const hValues = valuesOf(hLeft, spec.dims.h);
    // 下辺: 分割段 + 通り芯間の段
    if (spec.splitsV0 && vPts.length >= 2) {
      const pts = [vPts[0]];
      let acc = 0;
      for (const s of spec.splitsV0) {
        acc += s;
        pts.push(vPts[0] + toPt(spec, acc));
      }
      hDimRow(BOTTOM_SPLIT_Y, pts, spec.splitsV0.map(fmtDim), false);
    }
    if (vPts.length >= 2 && !spec.noRow2) hDimRow(BOTTOM_SPAN_Y, vPts, vValues, true);
    // 上辺: 通り芯間の段
    const vTopPts = vTop.map((o) => o.pos);
    if (vTopPts.length >= 2) hDimRow(TOP_SPAN_Y, vTopPts, spec.dimsTop || valuesOf(vTop, null), false);
    // 左辺・右辺
    if (hPts.length >= 2) vDimCol(LEFT_COL_X, hPts, hValues);
    const hRightPts = hRight.map((o) => o.pos);
    if (hRightPts.length >= 2) vDimCol(RIGHT_COL_X, hRightPts, spec.dimsRight || valuesOf(hRight, null));
  } else {
    // 旧式: ドット無しの浮き注記（フォールバック経路の検証用）
    for (let i = 0; i + 1 < pos.v.length; i++) {
      const mid = (pos.v[i].pos + pos.v[i + 1].pos) / 2;
      const str =
        spec.dims.v && spec.dims.v[i] != null ? spec.dims.v[i] : fmtDim(spec.vAxes[i + 1].mm - spec.vAxes[i].mm);
      textAt(mid - str.length * 2.5, 100, str, i === 0);
    }
    for (let i = 0; i + 1 < pos.h.length; i++) {
      const mid = (pos.h[i].pos + pos.h[i + 1].pos) / 2;
      const str =
        spec.dims.h && spec.dims.h[i] != null ? spec.dims.h[i] : fmtDim(spec.hAxes[i + 1].mm - spec.hAxes[i].mm);
      textAt(120, mid - 3, str, false);
    }
  }

  // ---- 右下の小さなキープラン（本図より小さい符号バブル） ----
  if (spec.keyPlan) {
    const kp = spec.keyPlan;
    const ox = kp.x != null ? kp.x : 660;
    const oy = kp.y != null ? kp.y : 20;
    const step = kp.step != null ? kp.step : 12;
    const r = kp.r != null ? kp.r : BUBBLE_R * 0.45; // 本図の半分以下の符号
    const w = (kp.labels.v.length - 1) * step;
    const h = (kp.labels.h.length - 1) * step;
    ops.push("0.3 w [3 2] 0 d");
    kp.labels.v.forEach((lab, i) => {
      const x = ox + i * step;
      ops.push(`${fmt(x)} ${fmt(oy)} m ${fmt(x)} ${fmt(oy + h)} l S`);
    });
    kp.labels.h.forEach((lab, i) => {
      const y = oy + i * step;
      ops.push(`${fmt(ox)} ${fmt(y)} m ${fmt(ox + w)} ${fmt(y)} l S`);
    });
    ops.push("[] 0 d 0.3 w");
    kp.labels.v.forEach((lab, i) => {
      const x = ox + i * step;
      ops.push(circleOps(x, oy - step, r, false));
      textAt(x - lab.length * 1.4, oy - step - 2, lab, false);
    });
    kp.labels.h.forEach((lab, i) => {
      const y = oy + i * step;
      ops.push(circleOps(ox - step, y, r, false));
      textAt(ox - step - lab.length * 1.4, y - 2, lab, false);
    });
  }

  const T = ["BT /F1 10 Tf", ...texts, `1 0 0 1 656 30 Tm ${textEnc("S=1/" + spec.den)} Tj`, "ET"];
  ops.push(T.join("\n"));
  return ops.join("\n");
}

// ---- クラシック xref のビルダ ----
class PDFBuilder {
  constructor() {
    this.objs = [null];
  }
  add(o) {
    this.objs.push(o);
    return this.objs.length - 1;
  }
  build(opts) {
    opts = opts || {};
    const chunks = [];
    let off = 0;
    const push = (s) => {
      const b = Buffer.isBuffer(s) ? s : Buffer.from(s, "latin1");
      chunks.push(b);
      off += b.length;
    };
    push("%PDF-1.6\n%\xE2\xE3\xCF\xD3\n");
    const offsets = [0];
    for (let i = 1; i < this.objs.length; i++) {
      offsets[i] = off;
      const o = this.objs[i];
      push(`${i} 0 obj\n`);
      if (o.stream) {
        push(`<< ${o.dict || ""} /Length ${o.stream.length} >>\nstream\n`);
        push(o.stream);
        push("\nendstream\nendobj\n");
      } else {
        push(o.body + "\nendobj\n");
      }
    }
    const xrefOff = off;
    let xref = `xref\n0 ${this.objs.length}\n0000000000 65535 f \n`;
    for (let i = 1; i < this.objs.length; i++) {
      xref += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
    }
    push(xref);
    const enc = opts.encrypt ? " /Encrypt 99 0 R" : "";
    push(`trailer\n<< /Size ${this.objs.length} /Root 1 0 R${enc} >>\n`);
    push(`startxref\n${opts.corruptStartxref ? 3 : xrefOff}\n%%EOF\n`);
    return new Uint8Array(Buffer.concat(chunks));
  }
}

function escLiteral(s) {
  return "(" + s.replace(/([\\()])/g, "\\$1") + ")";
}

// クラシック xref 版
function makeBasicPdf(spec, opts) {
  spec = spec || makeSpec();
  opts = opts || {};
  let content = drawingOps(spec, escLiteral, true);
  let mediaBox = "[0 0 842 595]";
  let rotate = "";
  if (opts.rotate === 90) {
    // ページは縦置きで作図をCCW回転し、/Rotate 90 で表示時に元に戻す
    content = "0 1 -1 0 595 0 cm\n" + content;
    mediaBox = "[0 0 595 842]";
    rotate = " /Rotate 90";
  }
  let contentBytes = Buffer.from(content, "latin1");
  let filter = "";
  if (opts.flate !== false) {
    contentBytes = zlib.deflateSync(contentBytes);
    filter = "/Filter /FlateDecode";
  }
  const b = new PDFBuilder();
  b.add({ body: "<< /Type /Catalog /Pages 2 0 R >>" });
  b.add({ body: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" });
  b.add({
    body:
      `<< /Type /Page /Parent 2 0 R /MediaBox ${mediaBox} ` +
      `/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R${rotate} >>`,
  });
  b.add({ dict: filter, stream: contentBytes });
  b.add({ body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>" });
  return b.build(opts);
}

// xref ストリーム + ObjStm + Type0 版
function makeAdvancedPdf(spec) {
  spec = spec || makeSpec();
  const chars = new Set();
  const collect = (s) => {
    for (const ch of s) chars.add(ch);
  };
  for (const a of spec.vAxes) collect(a.label);
  for (const a of spec.hAxes) collect(a.label);
  collect("0123456789.S=/");
  for (const arr of [spec.dims.v, spec.dims.h, spec.dimsTop, spec.dimsRight, spec.splitsV0]) {
    if (arr) arr.forEach((d) => d != null && collect(String(d)));
  }
  const codeOf = new Map();
  let next = 1;
  for (const ch of chars) codeOf.set(ch, next++);
  const hexEnc = (s) =>
    "<" + [...s].map((ch) => codeOf.get(ch).toString(16).padStart(4, "0")).join("") + ">";

  const content = drawingOps(spec, hexEnc, false);

  let bf = "";
  for (const [ch, code] of codeOf) {
    bf += `<${code.toString(16).padStart(4, "0")}> <${ch.charCodeAt(0).toString(16).padStart(4, "0")}>\n`;
  }
  const cmap =
    "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n" +
    "/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n" +
    "1 begincodespacerange\n<0000> <ffff>\nendcodespacerange\n" +
    `${codeOf.size} beginbfchar\n${bf}endbfchar\n` +
    "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend";

  const chunks = [];
  let off = 0;
  const offsets = {};
  const push = (s) => {
    const b = Buffer.isBuffer(s) ? s : Buffer.from(s, "latin1");
    chunks.push(b);
    off += b.length;
  };
  const writeStream = (num, dict, data) => {
    offsets[num] = off;
    push(`${num} 0 obj\n<< ${dict} /Length ${data.length} >>\nstream\n`);
    push(data);
    push("\nendstream\nendobj\n");
  };
  push("%PDF-1.6\n%\xE2\xE3\xCF\xD3\n");

  const inObj = {
    1: "<< /Type /Catalog /Pages 2 0 R >>",
    2: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    3:
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] " +
      "/Resources << /XObject << /Fm1 6 0 R >> >> /Contents 4 0 R >>",
    5:
      "<< /Type /Font /Subtype /Type0 /BaseFont /TestCID /Encoding /Identity-H " +
      "/DescendantFonts [7 0 R] /ToUnicode 8 0 R >>",
    7:
      "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /TestCID " +
      "/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 500 >>",
  };
  const stmNums = [1, 2, 3, 5, 7];
  let head = "";
  let body = "";
  for (const n of stmNums) {
    head += `${n} ${body.length} `;
    body += inObj[n] + "\n";
  }
  const first = head.length;
  const objStmData = zlib.deflateSync(Buffer.from(head + body, "latin1"));

  writeStream(4, "/Filter /FlateDecode", zlib.deflateSync(Buffer.from("q /Fm1 Do Q", "latin1")));
  writeStream(
    6,
    "/Type /XObject /Subtype /Form /BBox [0 0 842 595] " +
      "/Resources << /Font << /F1 5 0 R >> >> /Filter /FlateDecode",
    zlib.deflateSync(Buffer.from(content, "latin1"))
  );
  writeStream(8, "/Filter /FlateDecode", zlib.deflateSync(Buffer.from(cmap, "latin1")));
  writeStream(9, `/Type /ObjStm /N ${stmNums.length} /First ${first} /Filter /FlateDecode`, objStmData);

  const xrefOff = off;
  offsets[10] = xrefOff;
  const entries = [];
  entries[0] = [0, 0, 65535];
  const stmIdx = new Map(stmNums.map((n, i) => [n, i]));
  for (let n = 1; n <= 10; n++) {
    if (stmIdx.has(n)) entries[n] = [2, 9, stmIdx.get(n)];
    else entries[n] = [1, offsets[n], 0];
  }
  const cols = 7;
  const raw = Buffer.alloc(entries.length * cols);
  entries.forEach(([t, f2, f3], i) => {
    raw[i * cols] = t;
    raw.writeUInt32BE(f2 >>> 0, i * cols + 1);
    raw.writeUInt16BE(f3 & 0xffff, i * cols + 5);
  });
  const pred = Buffer.alloc(entries.length * (cols + 1));
  let prev = Buffer.alloc(cols);
  for (let i = 0; i < entries.length; i++) {
    pred[i * (cols + 1)] = 2;
    for (let j = 0; j < cols; j++) {
      pred[i * (cols + 1) + 1 + j] = (raw[i * cols + j] - prev[j]) & 0xff;
    }
    prev = raw.subarray(i * cols, (i + 1) * cols);
  }
  const xrefData = zlib.deflateSync(pred);
  writeStream(
    10,
    "/Type /XRef /Size 11 /Root 1 0 R /W [1 4 2] /Index [0 11] /Filter /FlateDecode " +
      `/DecodeParms << /Predictor 12 /Colors 1 /BitsPerComponent 8 /Columns ${cols} >>`,
    xrefData
  );
  push(`startxref\n${xrefOff}\n%%EOF\n`);
  return new Uint8Array(Buffer.concat(chunks));
}

module.exports = {
  makeSpec,
  makeBasicPdf,
  makeAdvancedPdf,
  axisPositions,
  toPt,
  X0,
  Y0,
  V_FROM,
  V_TO,
  H_FROM,
  H_TO,
  BOTTOM_SPAN_Y,
  BOTTOM_SPLIT_Y,
  TOP_SPAN_Y,
  LEFT_COL_X,
  RIGHT_COL_X,
  BUBBLE_R,
};
