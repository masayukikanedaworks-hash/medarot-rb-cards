// 検査CLI (tools/inspect.js) のテスト — 別プロセスで起動して出力を確認する
"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const mk = require("./make_pdf");
const { assert } = require("./helpers");

const CLI = path.join(__dirname, "..", "tools", "inspect.js");

function run(args, allowExit) {
  try {
    return execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  } catch (e) {
    if (allowExit && e.stdout != null && e.status === allowExit) return e.stdout;
    throw e;
  }
}

function tmpPdf(name, bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zumen-check-"));
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  return p;
}

exports.単体の測定レポート = () => {
  const p = tmpPdf("base.pdf", mk.makeBasicPdf());
  const out = run([p]);
  assert.ok(out.includes("1/100"), "縮尺の自動推定が表示される");
  assert.ok(out.includes("X1"), "符号が表示される");
  assert.ok(out.includes("X1〜X2: 6000.0 mm"), "芯々寸法が表示される: \n" + out);
  assert.ok(out.includes("注記 6000"), "寸法注記の対応が表示される");
};

exports.JSON出力 = () => {
  const p = tmpPdf("base.pdf", mk.makeBasicPdf());
  const j = JSON.parse(run([p, "--json"]));
  assert.equal(j.scaleDen, 100);
  assert.equal(j.axes.v.filter((a) => a.defaultOn).length, 3);
  assert.equal(j.axes.h.filter((a) => a.defaultOn).length, 2);
  assert.equal(j.spacings.v[0].gapMm, 6000);
  assert.equal(j.spacings.v[0].annot, 6000);
};

exports.照合モードはNG検出で終了コード2 = () => {
  const spec2 = mk.makeSpec();
  spec2.vAxes[2].mm = 11020;
  const p1 = tmpPdf("base.pdf", mk.makeBasicPdf());
  const p2 = tmpPdf("cmp.pdf", mk.makeBasicPdf(spec2));
  const out = run([p1, p2], 2);
  assert.ok(out.includes("照合結果"), out);
  assert.ok(out.includes("NG 2 件"), "X2〜X3と全体寸法のNG: \n" + out);
  assert.ok(out.includes("X2〜X3: 5000.0 → 5020.0"), out);
};
