#!/usr/bin/env node
// 回帰テストランナー
// _order.json の順に連結したソース（= dist と同じもの）をグローバルへ読み込み、
// test/*.test.js を順に実行する。外部依存なし（Node 18+ を想定）。
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const srcJs = path.join(root, "src", "js");
const order = JSON.parse(fs.readFileSync(path.join(srcJs, "_order.json"), "utf8"));
const code = order.map((f) => fs.readFileSync(path.join(srcJs, f), "utf8")).join("\n;\n");
(0, eval)(code); // globalThis.ZC が定義される

if (typeof DecompressionStream === "undefined") {
  console.error("このテストは DecompressionStream が必要です（Node 18 以上で実行してください）");
  process.exit(1);
}

const files = fs
  .readdirSync(__dirname)
  .filter((f) => f.endsWith(".test.js"))
  .sort();

(async () => {
  let pass = 0;
  const failures = [];
  for (const f of files) {
    const mod = require(path.join(__dirname, f));
    for (const [name, fn] of Object.entries(mod)) {
      if (typeof fn !== "function") continue;
      const label = f.replace(/\.test\.js$/, "") + " > " + name;
      try {
        await fn();
        pass++;
        console.log("  ok   " + label);
      } catch (e) {
        failures.push({ label, e });
        console.error("  FAIL " + label);
      }
    }
  }
  console.log("");
  if (failures.length) {
    for (const { label, e } of failures) {
      console.error("--- " + label + " ---");
      console.error(e && e.stack ? e.stack : e);
    }
    console.error(`\n${pass} passed, ${failures.length} FAILED`);
    process.exit(1);
  }
  console.log(`${pass} passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
