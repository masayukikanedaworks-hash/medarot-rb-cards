#!/usr/bin/env node
// 検査CLI: PDFの取り込み内容と通り芯の測定結果をコマンドラインで確認する。
// ブラウザUIと同じ抽出・検出・縮尺推定・照合ロジック（連結ソース）をそのまま使う。
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
  node tools/inspect.js <図面.pdf> [オプション]             取り込み・測定結果を表示
  node tools/inspect.js <基準.pdf> <比較.pdf> [オプション]  2枚を照合

オプション:
  --page N / --page2 N    対象ページ（1始まり、既定 1）
  --scale D / --scale2 D  縮尺分母の手動指定（例: 100）。省略時は寸法値から自動推定
  --tol T                 照合の許容差 mm（既定 1）
  --all                   既定OFFの芯候補も測定対象に含める
  --texts                 抽出テキストを一覧表示
  --json                  JSONで出力`);
}

function parseArgs(argv) {
  const opt = { files: [], page: 1, page2: 1, scale: null, scale2: null, tol: 1, all: false, texts: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--page") opt.page = Number(argv[++i]);
    else if (a === "--page2") opt.page2 = Number(argv[++i]);
    else if (a === "--scale") opt.scale = Number(argv[++i]);
    else if (a === "--scale2") opt.scale2 = Number(argv[++i]);
    else if (a === "--tol") opt.tol = Number(argv[++i]);
    else if (a === "--all") opt.all = true;
    else if (a === "--texts") opt.texts = true;
    else if (a === "--json") opt.json = true;
    else if (a === "--help" || a === "-h") return null;
    else if (a.startsWith("--")) throw new Error("不明なオプション: " + a);
    else opt.files.push(a);
  }
  if (opt.files.length < 1 || opt.files.length > 2) return null;
  return opt;
}

const mm = (v, d) => ZC.util.fmtMm(v, d === undefined ? 1 : d);

async function analyze(file, pageNo, scaleDen, includeAll) {
  const bytes = new Uint8Array(fs.readFileSync(file));
  const doc = await ZC.pdf.PDFDocument.load(bytes);
  const pages = await doc.getPages();
  if (!(pageNo >= 1 && pageNo <= pages.length)) {
    throw new Error(`ページ ${pageNo} はありません（全 ${pages.length} ページ）`);
  }
  const extract = await new ZC.content.ContentExtractor(doc).run(pages[pageNo - 1]);
  const det = ZC.axis.detect(extract);
  const pick = (list) => list.filter((a) => includeAll || a.defaultOn);
  const onV = pick(det.v);
  const onH = pick(det.h);
  const samples = ZC.scale.collectDimSamples(onV, onH, extract.texts);
  const inf = ZC.scale.infer(samples);
  let den;
  let scaleSrc;
  if (scaleDen) {
    den = scaleDen;
    scaleSrc = "手動指定";
  } else if (inf.den != null) {
    den = inf.den;
    scaleSrc = `寸法値${inf.count}件から自動推定`;
  } else {
    den = 100;
    scaleSrc = "推定不能のため既定値 1/100";
  }
  const mmPerPt = ZC.scale.mmPerPtFromDen(den);
  return { file, pageNo, pageCount: pages.length, extract, det, onV, onH, samples, den, scaleSrc, mmPerPt };
}

// 隣接ペアの芯々寸法（寸法注記が対応していれば併記）
function spacings(list, mmPerPt, samples, dir) {
  const sorted = list.slice().sort((a, b) => a.pos - b.pos);
  const out = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    const s = samples.find((x) => x.dir === dir && x.a === a && x.b === b);
    out.push({
      from: ZC.axis.displayName(a),
      to: ZC.axis.displayName(b),
      gapPt: b.pos - a.pos,
      gapMm: (b.pos - a.pos) * mmPerPt,
      annot: s ? s.value : null,
    });
  }
  return out;
}

function axisJson(a, mmPerPt) {
  return {
    name: ZC.axis.displayName(a),
    label: a.label,
    dir: a.dir,
    posPt: round(a.pos, 3),
    posMm: round(a.pos * mmPerPt, 1),
    lengthMm: round(a.extent * mmPerPt, 0),
    dashed: a.dashed,
    frameSuspect: a.frameSuspect,
    defaultOn: a.defaultOn,
    pieces: a.pieces,
  };
}

function round(v, d) {
  const k = 10 ** d;
  return Math.round(v * k) / k;
}

function reportOne(r, opt) {
  const e = r.extract;
  const lines = [];
  lines.push(`━━━ ${r.file}`);
  lines.push(
    `取り込み : ページ ${r.pageNo}/${r.pageCount}  ${mm(e.width, 0)} x ${mm(e.height, 0)} pt` +
      (e.rotate ? `（回転 ${e.rotate}° 補正済み）` : "")
  );
  lines.push(
    `抽出     : 線分 ${e.segments.length} 本（うち曲線近似 ${e.segments.filter((s) => s.curve).length}） / ` +
      `テキスト ${e.texts.length} 件 / 画像 ${e.imageCount} 個`
  );
  lines.push(`縮尺     : 1/${r.den}（${r.scaleSrc}） mm/pt = ${round(r.mmPerPt, 4)}`);
  for (const [dir, all, on, label] of [
    ["v", r.det.v, r.onV, "縦（X方向の並び）"],
    ["h", r.det.h, r.onH, "横（Y方向の並び）"],
  ]) {
    lines.push(`\n■ 通り芯 ${label} — 候補 ${all.length} 本、測定対象 ${on.length} 本`);
    for (const a of all) {
      const used = on.includes(a);
      lines.push(
        `  [${used ? "✓" : " "}] ${ZC.axis.displayName(a).padEnd(6)} ` +
          `位置 ${mm(a.pos * r.mmPerPt).padStart(9)} mm (${round(a.pos, 3)} pt)  ` +
          `長さ ${mm(a.extent * r.mmPerPt, 0).padStart(6)} mm  ` +
          (a.dashed ? "鎖線/破線" : "実線") +
          (a.frameSuspect ? "・図枠?" : "") +
          (a.label == null ? "・符号なし" : "")
      );
    }
    const sp = spacings(on, r.mmPerPt, r.samples, dir);
    if (sp.length) {
      lines.push(`  芯々寸法:`);
      for (const s of sp) {
        let note = "";
        if (s.annot != null) {
          const dv = mm(s.gapMm - s.annot);
          note = `  [注記 ${s.annot} / 差 ${dv.startsWith("-") ? "" : "+"}${dv}]`;
        }
        lines.push(`    ${s.from}〜${s.to}: ${mm(s.gapMm)} mm (${round(s.gapPt, 3)} pt)${note}`);
      }
      if (on.length >= 2) {
        const sorted = on.slice().sort((a, b) => a.pos - b.pos);
        const total = (sorted[sorted.length - 1].pos - sorted[0].pos) * r.mmPerPt;
        lines.push(
          `    全体 ${ZC.axis.displayName(sorted[0])}〜${ZC.axis.displayName(sorted[sorted.length - 1])}: ${mm(total)} mm`
        );
      }
    }
  }
  if (opt.texts) {
    lines.push(`\n■ 抽出テキスト`);
    for (const t of e.texts) {
      lines.push(`  "${t.str}" @ (${round(t.x, 1)}, ${round(t.y, 1)}) size ${round(t.size, 1)}`);
    }
  }
  return lines.join("\n");
}

function jsonOne(r) {
  const e = r.extract;
  return {
    file: r.file,
    page: r.pageNo,
    pageCount: r.pageCount,
    widthPt: round(e.width, 2),
    heightPt: round(e.height, 2),
    rotate: e.rotate,
    segments: e.segments.length,
    curveSegments: e.segments.filter((s) => s.curve).length,
    texts: e.texts.length,
    images: e.imageCount,
    scaleDen: r.den,
    scaleSource: r.scaleSrc,
    mmPerPt: round(r.mmPerPt, 6),
    axes: {
      v: r.det.v.map((a) => axisJson(a, r.mmPerPt)),
      h: r.det.h.map((a) => axisJson(a, r.mmPerPt)),
    },
    spacings: {
      v: spacings(r.onV, r.mmPerPt, r.samples, "v").map((s) => ({ ...s, gapPt: round(s.gapPt, 3), gapMm: round(s.gapMm, 1) })),
      h: spacings(r.onH, r.mmPerPt, r.samples, "h").map((s) => ({ ...s, gapPt: round(s.gapPt, 3), gapMm: round(s.gapMm, 1) })),
    },
  };
}

(async () => {
  const opt = parseArgs(process.argv.slice(2));
  if (!opt) {
    usage();
    process.exit(process.argv.length > 2 ? 1 : 0);
  }
  const base = await analyze(opt.files[0], opt.page, opt.scale, opt.all);
  if (opt.files.length === 1) {
    if (opt.json) console.log(JSON.stringify(jsonOne(base), null, 2));
    else console.log(reportOne(base, opt));
    return;
  }
  // 照合モード
  const cmp = await analyze(opt.files[1], opt.page2, opt.scale2, opt.all);
  const sideOf = (r, name) => ({ v: r.onV, h: r.onH, mmPerPt: r.mmPerPt, dimSamples: r.samples, name });
  const result = ZC.compare.compare(sideOf(base, "基準"), sideOf(cmp, "比較"), {
    tol: opt.tol,
    checks: { labels: true, spacing: true, total: true, dims: true },
  });
  if (opt.json) {
    console.log(JSON.stringify({ base: jsonOne(base), cmp: jsonOne(cmp), tolMm: opt.tol, result }, null, 2));
    return;
  }
  console.log(reportOne(base, opt));
  console.log("");
  console.log(reportOne(cmp, opt));
  console.log(`\n━━━ 照合結果（許容差 ±${opt.tol}mm）`);
  const s = result.summary;
  console.log(`NG ${s.ng} 件 / 要確認 ${s.warn} 件 / OK ${s.ok} 件`);
  for (const row of result.rows) {
    const st = row.status === "WARN" ? "要確認" : row.status;
    const dv = row.diff == null ? null : mm(row.diff);
    const diff = dv == null ? "" : `  (差 ${dv.startsWith("-") ? "" : "+"}${dv}mm)`;
    console.log(
      `  [${st.padEnd(3)}] ${row.check} / ${row.dir} / ${row.item}: ${row.base} → ${row.cmp}${diff}` +
        (row.note ? `  ※${row.note}` : "")
    );
  }
  process.exitCode = s.ng > 0 ? 2 : 0; // NGありは終了コード2（CI等での利用を想定）
})().catch((e) => {
  console.error("エラー: " + (e && e.message ? e.message : e));
  process.exit(1);
});
