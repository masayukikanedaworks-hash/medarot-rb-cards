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

exports.辺別の拾い出しレポート = () => {
  const p = tmpPdf("base.pdf", mk.makeBasicPdf());
  const out = run([p]);
  for (const side of ["上辺", "右辺", "下辺", "左辺"]) {
    assert.ok(out.includes(side), side + "が表示される: \n" + out);
  }
  assert.ok(out.includes("X1~X2：6000（2730.5+3269.5）"), "分割の内訳付きで表示: \n" + out);
  assert.ok(out.includes("Y1~Y2：6000"), "横方向の寸法");
  assert.ok(out.includes("符号バブル(円) 10 個"));
  assert.ok(out.includes("円で囲まれた符号 5 本"));
};

exports.JSON出力 = () => {
  const p = tmpPdf("base.pdf", mk.makeBasicPdf());
  const j = JSON.parse(run([p, "--json"]));
  assert.equal(j.circles, 10);
  assert.equal(j.dots, 13);
  assert.deepEqual(j.sides.top.axes, ["X1", "X2", "X3"]);
  assert.deepEqual(j.sides.right.axes, ["Y1", "Y2"]);
  assert.equal(j.sides.bottom.spans[0].value, 6000);
  assert.deepEqual(j.sides.bottom.spans[0].parts, [2730.5, 3269.5]);
  assert.equal(j.sides.top.total.value, 11000);
};

exports.照合モードはNG検出で終了コード2 = () => {
  const spec = mk.makeSpec();
  spec.dimsTop = ["6020", "5000"];
  const p1 = tmpPdf("base.pdf", mk.makeBasicPdf());
  const p2 = tmpPdf("cmp.pdf", mk.makeBasicPdf(spec));
  const out = run([p1, p2], 2);
  assert.ok(out.includes("照合結果"), out);
  assert.ok(out.includes("上辺 / 芯々寸法 / X1~X2: 6000 → 6020"), out);
};
