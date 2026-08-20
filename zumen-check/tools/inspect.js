#!/usr/bin/env node
// 検査CLI: PDFの取り込み内容と辺別（上辺/右辺/下辺/左辺）の拾い出し結果を確認する。
// ブラウザUIと同じ抽出・検出・寸法読取・照合ロジック（連結ソース）をそのまま使う。
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// 連結ソースを読み込んで ZC を定義（test/run.js と同じ方式）
const root = path.join(__dirname, "..");
const srcJs = path.join(root, "src", "js");
const order = JSON.parse(fs.readFileSync(path.join(srcJs, "_order.json"), "utf8"));
(0, eval)(order.map((f) => fs.readFileSync(path.join(srcJs, f), "utf8")).join("\n;\n"));

function usage() {
  console.log(`使い方:
  node tools/inspect.js <図面.pdf> [オプション]             辺別の拾い出し結果を表示
  node tools/inspect.js <基準.pdf> <比較.pdf> [オプション]  2枚を照合

オプション:
  --page N / --page2 N    対象ページ（1始まり、既定 1）
  --tol T                 照合の許容差 mm（既定 1）
  --axes                  通り芯の一覧も表示
  --json                  JSONで出力

通り芯は「円で囲まれた X○○ / Y○○」のみを拾います。寸法は図面に記載された
数字（黒いドット間の直線の上）を読み、分割記載は合計します。縮尺は使いません。`);
}

function parseArgs(argv) {
  const opt = { files: [], page: 1, page2: 1, tol: 1, axes: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--page") opt.page = Number(argv[++i]);
    else if (a === "--page2") opt.page2 = Number(argv[++i]);
    else if (a === "--tol") opt.tol = Number(argv[++i]);
    else if (a === "--axes") opt.axes = true;
    else if (a === "--json") opt.json = true;
    else if (a === "--help" || a === "-h") return null;
    else if (a.startsWith("--")) throw new Error("不明なオプション: " + a);
    else opt.files.push(a);
  }
  if (opt.files.length < 1 || opt.files.length > 2) return null;
  return opt;
}

const SIDE_ORDER = ["top", "right", "bottom", "left"];

async function analyze(file, pageNo) {
  const bytes = new Uint8Array(fs.readFileSync(file));
  const doc = await ZC.pdf.PDFDocument.load(bytes);
  const pages = await doc.getPages();
  if (!(pageNo >= 1 && pageNo <= pages.length)) {
    throw new Error(`ページ ${pageNo} はありません（全 ${pages.length} ページ）`);
  }
  const extract = await new ZC.content.ContentExtractor(doc).run(pages[pageNo - 1]);
  const det = ZC.axis.detect(extract);
  const dims = ZC.dims.extract(extract);
  const sides = ZC.sides.build(det, dims.entries);
  return { file, pageNo, pageCount: pages.length, extract, det, dims, sides };
}

function reportOne(r, opt) {
  const e = r.extract;
  const lines = [];
  lines.push(`━━━ ${r.file}`);
  lines.push(
    `取り込み : ページ ${r.pageNo}/${r.pageCount}  ${e.width.toFixed(0)} x ${e.height.toFixed(0)} pt` +
      (e.rotate ? `（回転 ${e.rotate}° 補正済み）` : "")
  );
  lines.push(
    `抽出     : 線分 ${e.segments.length} 本 / テキスト ${e.texts.length} 件 / ` +
      `符号バブル(円) ${(e.circles || []).length} 個 / 画像 ${e.imageCount} 個`
  );
  lines.push(`寸法読取 : 黒ドット ${r.dims.dots.length} 点 / 記載寸法 ${r.dims.entries.length} 区間`);
  const labeled = r.det.v.concat(r.det.h).filter((a) => a.label != null);
  lines.push(
    `通り芯   : 円で囲まれた符号 ${labeled.length} 本` +
      `（縦X ${r.det.v.filter((a) => a.label != null).length} / 横Y ${r.det.h.filter((a) => a.label != null).length}）`
  );
  lines.push("");
  for (const key of SIDE_ORDER) {
    const s = r.sides[key];
    lines.push(s.name);
    if (!s.axes.length) {
      lines.push("  （通り芯なし）");
    } else if (!s.spans.length) {
      lines.push("  " + s.axes.map((a) => a.label).join(" ") + "（区間なし）");
    } else {
      for (const sp of s.spans) lines.push(ZC.sides.formatSpan(sp));
      if (s.total) {
        lines.push(
          "  全体 " + s.total.from + "~" + s.total.to + "：" +
            (s.total.value == null ? "記載なし" : ZC.sides.fmtVal(s.total.value))
        );
      }
    }
    lines.push("");
  }
  if (opt.axes) {
    lines.push("■ 通り芯一覧");
    for (const ax of r.det.v.concat(r.det.h)) {
      if (ax.label == null) continue;
      lines.push(
        `  ${ax.label.padEnd(6)} ${ax.dir === "v" ? "縦(X)" : "横(Y)"} ` +
          `符号の辺: ${ax.bubbles.map((b) => ZC.axis.SIDE_NAME[b.side]).join("・")} ` +
          `${ax.dashed ? "鎖線" : "実線"}`
      );
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

function jsonOne(r) {
  const e = r.extract;
  const sides = {};
  for (const key of SIDE_ORDER) {
    const s = r.sides[key];
    sides[key] = {
      name: s.name,
      axes: s.axes.map((a) => a.label),
      spans: s.spans.map((sp) => ({ from: sp.from, to: sp.to, value: sp.value, parts: sp.parts, conflict: sp.conflict })),
      total: s.total ? { from: s.total.from, to: s.total.to, value: s.total.value } : null,
    };
  }
  return {
    file: r.file,
    page: r.pageNo,
    pageCount: r.pageCount,
    widthPt: Math.round(e.width * 100) / 100,
    heightPt: Math.round(e.height * 100) / 100,
    rotate: e.rotate,
    segments: e.segments.length,
    texts: e.texts.length,
    circles: (e.circles || []).length,
    dots: r.dims.dots.length,
    dimEntries: r.dims.entries.length,
    sides,
  };
}

(async () => {
  const opt = parseArgs(process.argv.slice(2));
  if (!opt) {
    usage();
    process.exit(process.argv.length > 2 ? 1 : 0);
  }
  const base = await analyze(opt.files[0], opt.page);
  if (opt.files.length === 1) {
    if (opt.json) console.log(JSON.stringify(jsonOne(base), null, 2));
    else console.log(reportOne(base, opt));
    return;
  }
  const cmp = await analyze(opt.files[1], opt.page2);
  const result = ZC.compare.compare(
    { sides: base.sides, name: "基準" },
    { sides: cmp.sides, name: "比較" },
    { tol: opt.tol, checks: { labels: true, spacing: true, total: true } }
  );
  if (opt.json) {
    console.log(JSON.stringify({ base: jsonOne(base), cmp: jsonOne(cmp), tolMm: opt.tol, result }, null, 2));
    return;
  }
  console.log(reportOne(base, opt));
  console.log("");
  console.log(reportOne(cmp, opt));
  console.log(`━━━ 照合結果（許容差 ±${opt.tol}mm）`);
  const s = result.summary;
  console.log(`NG ${s.ng} 件 / 要確認 ${s.warn} 件 / OK ${s.ok} 件`);
  for (const row of result.rows) {
    const st = row.status === "WARN" ? "要確認" : row.status;
    const dv = row.diff == null ? null : ZC.sides.fmtVal(row.diff);
    const diff = dv == null ? "" : `  (差 ${dv.startsWith("-") ? "" : "+"}${dv}mm)`;
    console.log(
      `  [${st.padEnd(3)}] ${row.side} / ${row.check} / ${row.item}: ${row.base} → ${row.cmp}${diff}` +
        (row.note ? `  ※${row.note}` : "")
    );
  }
  process.exitCode = s.ng > 0 ? 2 : 0; // NGありは終了コード2（CI等での利用を想定）
})().catch((e) => {
  console.error("エラー: " + (e && e.message ? e.message : e));
  process.exit(1);
});
