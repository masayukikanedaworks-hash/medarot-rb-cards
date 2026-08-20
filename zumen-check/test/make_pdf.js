// テスト用の合成ベクターPDF生成器
// 通り芯・寸法線（黒ドット+分割記載）・図枠・ノイズを含む簡易平面図を、2系統のPDF構造で書き出す:
//   makeBasicPdf    … クラシック xref 表 + Type1(WinAnsi) フォント
//   makeAdvancedPdf … xref ストリーム(Predictor 12) + ObjStm + Type0(Identity-H)+ToUnicode + Form XObject
// 寸法は実図面と同様に「黒ドット間の直線の上の数字」で表現する（dots:false で旧式の浮き数字）。
"use strict";

const zlib = require("node:zlib");

const PT_PER_MM_PAPER = 72 / 25.4; // 紙上mm → pt
const X0 = 150; // X1(基準)の紙上位置 pt
const Y0 = 120; // Y1(基準)の紙上位置 pt
const ROW1_Y = 85; // 分割寸法の段
const ROW2_Y = 97; // 通り芯間寸法の段
const COL_X = 95; // 縦向き寸法線（横芯用）

function makeSpec() {
  return {
    den: 100, // 縮尺 1/100
    vAxes: [
      { label: "X1", mm: 0 },
      { label: "X2", mm: 6000 },
      { label: "X3", mm: 11000, pieces: true }, // 短い線分の連なりで鎖線を模す
    ],
    hAxes: [
      { label: "Y1", mm: 0 },
      { label: "Y2", mm: 6000 },
    ],
    dims: {}, // {v:[...], h:[...]} 通り芯間寸法（row2/列）の注記上書き（省略時は実距離）
    splitsV0: [2730.5, 3269.5], // X1〜X2 の分割寸法（row1）。null で分割段なし
    dots: true, // false で黒ドット無しの旧式注記（フォールバック検証用）
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
  const r = Math.round(mm * 10) / 10;
  return Number.isInteger(r) ? String(r) : String(r);
}

// 黒ドット（塗り潰し円 r=0.9）
function dotOps(cx, cy) {
  const r = 0.9;
  const k = r * 0.5523;
  return (
    `${fmt(cx + r)} ${fmt(cy)} m ` +
    `${fmt(cx + r)} ${fmt(cy + k)} ${fmt(cx + k)} ${fmt(cy + r)} ${fmt(cx)} ${fmt(cy + r)} c ` +
    `${fmt(cx - k)} ${fmt(cy + r)} ${fmt(cx - r)} ${fmt(cy + k)} ${fmt(cx - r)} ${fmt(cy)} c ` +
    `${fmt(cx - r)} ${fmt(cy - k)} ${fmt(cx - k)} ${fmt(cy - r)} ${fmt(cx)} ${fmt(cy - r)} c ` +
    `${fmt(cx + k)} ${fmt(cy - r)} ${fmt(cx + r)} ${fmt(cy - k)} ${fmt(cx + r)} ${fmt(cy)} c f`
  );
}

// 図の描画オペレータ列を作る。textEnc は文字列→表示オペランドの変換
function drawingOps(spec, textEnc, useTJ) {
  const pos = axisPositions(spec);
  const ops = [];

  // 図枠とタイトル欄（実線・長い → 図枠判定/除外のテスト対象）
  ops.push("0.7 w [] 0 d");
  ops.push("25 25 792 545 re S");
  ops.push("640 30 170 40 re S");
  ops.push("640 50 m 810 50 l S");
  ops.push("700 30 m 700 50 l S");

  // 壁の二重線（X1沿い・長め実線 → 誤検出候補になるが既定OFFのはず）
  ops.push("1 w");
  ops.push(`${fmt(pos.v[0].pos - 5.5)} 120 m ${fmt(pos.v[0].pos - 5.5)} 320 l S`);
  ops.push(`${fmt(pos.v[0].pos + 5.5)} 120 m ${fmt(pos.v[0].pos + 5.5)} 320 l S`);

  // ノイズ: 斜線・ドア円弧・短い破線
  ops.push("0.4 w");
  ops.push("80 60 m 200 110 l S");
  ops.push("540 200 m 540 222.09 522.09 240 500 240 c S");
  ops.push("[3 3] 0 d 600 200 m 600 260 l S [] 0 d");

  // 通り芯（縦）
  for (const a of pos.v) {
    const specAx = spec.vAxes[pos.v.indexOf(a)];
    ops.push("0.5 w");
    if (specAx.pieces) {
      ops.push("[] 0 d");
      for (let y = 60; y < 530; y += 23.5) {
        const y2 = Math.min(y + 18, 530);
        ops.push(`${fmt(a.pos)} ${fmt(y)} m ${fmt(a.pos)} ${fmt(y2)} l S`);
      }
    } else {
      ops.push("[6 3 1.5 3] 0 d");
      ops.push(`${fmt(a.pos)} 60 m ${fmt(a.pos)} 530 l S`);
      ops.push("[] 0 d");
    }
  }
  // 通り芯（横）
  for (const a of pos.h) {
    ops.push("0.5 w [6 3 1.5 3] 0 d");
    ops.push(`70 ${fmt(a.pos)} m 740 ${fmt(a.pos)} l S`);
    ops.push("[] 0 d");
  }

  // 通り芯符号のバブル（円 = ベジェ4本。曲線が検出を邪魔しないことのテスト）
  {
    const cx = pos.v[0].pos;
    const cy = 549;
    const r = 10;
    const k = r * 0.5523;
    ops.push("0.5 w");
    ops.push(
      `${fmt(cx + r)} ${fmt(cy)} m ` +
        `${fmt(cx + r)} ${fmt(cy + k)} ${fmt(cx + k)} ${fmt(cy + r)} ${fmt(cx)} ${fmt(cy + r)} c ` +
        `${fmt(cx - k)} ${fmt(cy + r)} ${fmt(cx - r)} ${fmt(cy + k)} ${fmt(cx - r)} ${fmt(cy)} c ` +
        `${fmt(cx - r)} ${fmt(cy - k)} ${fmt(cx - k)} ${fmt(cy - r)} ${fmt(cx)} ${fmt(cy - r)} c ` +
        `${fmt(cx + k)} ${fmt(cy - r)} ${fmt(cx + r)} ${fmt(cy - k)} ${fmt(cx + r)} ${fmt(cy)} c S`
    );
  }

  // ---- 寸法 ----
  const texts = []; // {op} BTブロック内に入れるテキストオペレータ
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

  if (spec.dots) {
    ops.push("0.4 w [] 0 d");
    // 横向き寸法線を1段描くヘルパ（points: x座標列 / values: 各区間の注記）
    const hDimRow = (rowY, points, values, tjFirst) => {
      ops.push(`${fmt(points[0])} ${fmt(rowY)} m ${fmt(points[points.length - 1])} ${fmt(rowY)} l S`);
      for (const p of points) ops.push(dotOps(p, rowY));
      for (let i = 0; i + 1 < points.length; i++) {
        const str = values[i];
        if (str == null) continue;
        const mid = (points[i] + points[i + 1]) / 2;
        textAt(mid - str.length * 2.5, rowY + 1.5, str, tjFirst && i === 0);
      }
    };
    // 段1: X1〜X2 の分割寸法
    if (spec.splitsV0 && pos.v.length >= 2) {
      const pts = [pos.v[0].pos];
      let acc = 0;
      for (const s of spec.splitsV0) {
        acc += s;
        pts.push(pos.v[0].pos + toPt(spec, acc));
      }
      hDimRow(ROW1_Y, pts, spec.splitsV0.map(fmtDim), false);
    }
    // 段2: 通り芯間の寸法（全縦芯）。noRow2 で分割段のみにできる（合計読み取りのテスト用）
    if (pos.v.length >= 2 && !spec.noRow2) {
      const pts = pos.v.map((a) => a.pos);
      const values = [];
      for (let i = 0; i + 1 < spec.vAxes.length; i++) {
        const ov = spec.dims.v && spec.dims.v[i] != null ? spec.dims.v[i] : fmtDim(spec.vAxes[i + 1].mm - spec.vAxes[i].mm);
        values.push(ov);
      }
      hDimRow(ROW2_Y, pts, values, true);
    }
    // 縦向き寸法線（横芯用・数字は90度回転で線の左）
    if (pos.h.length >= 2) {
      const pts = pos.h.map((a) => a.pos);
      ops.push(`${fmt(COL_X)} ${fmt(pts[0])} m ${fmt(COL_X)} ${fmt(pts[pts.length - 1])} l S`);
      for (const p of pts) ops.push(dotOps(COL_X, p));
      for (let i = 0; i + 1 < pts.length; i++) {
        const str =
          spec.dims.h && spec.dims.h[i] != null ? spec.dims.h[i] : fmtDim(spec.hAxes[i + 1].mm - spec.hAxes[i].mm);
        const mid = (pts[i] + pts[i + 1]) / 2;
        textRotAt(COL_X - 2.5, mid - str.length * 2.5, str);
      }
    }
  } else {
    // 旧式: ドット無しの浮き注記（フォールバック経路の検証用）
    for (let i = 0; i + 1 < pos.v.length; i++) {
      const mid = (pos.v[i].pos + pos.v[i + 1].pos) / 2;
      const str =
        spec.dims.v && spec.dims.v[i] != null ? spec.dims.v[i] : fmtDim(spec.vAxes[i + 1].mm - spec.vAxes[i].mm);
      textAt(mid - str.length * 2.5, 75, str, i === 0);
    }
    for (let i = 0; i + 1 < pos.h.length; i++) {
      const mid = (pos.h[i].pos + pos.h[i + 1].pos) / 2;
      const str =
        spec.dims.h && spec.dims.h[i] != null ? spec.dims.h[i] : fmtDim(spec.hAxes[i + 1].mm - spec.hAxes[i].mm);
      textAt(92, mid - 3, str, false);
    }
  }

  // 符号ラベルとタイトル
  const T = ["BT /F1 10 Tf"];
  for (const a of pos.v) T.push(`1 0 0 1 ${fmt(a.pos - 7)} 540 Tm ${textEnc(a.label)} Tj`);
  for (const a of pos.h) T.push(`1 0 0 1 44 ${fmt(a.pos - 4)} Tm ${textEnc(a.label)} Tj`);
  T.push(...texts);
  T.push(`1 0 0 1 648 42 Tm ${textEnc("S=1/" + spec.den)} Tj`);
  T.push("ET");
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
  // 使う文字の収集 → 2バイトコード割り当て
  const chars = new Set();
  const collect = (s) => {
    for (const ch of s) chars.add(ch);
  };
  for (const a of spec.vAxes) collect(a.label);
  for (const a of spec.hAxes) collect(a.label);
  collect("0123456789.S=/");
  if (spec.dims.v) spec.dims.v.forEach((d) => d && collect(d));
  if (spec.dims.h) spec.dims.h.forEach((d) => d && collect(d));
  const codeOf = new Map();
  let next = 1;
  for (const ch of chars) codeOf.set(ch, next++);
  const hexEnc = (s) =>
    "<" + [...s].map((ch) => codeOf.get(ch).toString(16).padStart(4, "0")).join("") + ">";

  const content = drawingOps(spec, hexEnc, false);

  // ToUnicode CMap
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

  // xref ストリーム（W [1 4 2], PNG Up 予測子）
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
    pred[i * (cols + 1)] = 2; // Up フィルタ
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

module.exports = { makeSpec, makeBasicPdf, makeAdvancedPdf, axisPositions, toPt, X0, Y0, ROW1_Y, ROW2_Y, COL_X };
