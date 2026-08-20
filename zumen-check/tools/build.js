#!/usr/bin/env node
// ビルド: src/js/_order.json の順にファイルを連結して dist/zumen-check.html を生成する。
// バンドラは使わない。テンプレートの <!--@SCRIPTS--> を <script> ブロックで置き換えるだけ。
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const srcJs = path.join(root, "src", "js");

const order = JSON.parse(fs.readFileSync(path.join(srcJs, "_order.json"), "utf8"));
const files = fs.readdirSync(srcJs).filter((f) => f.endsWith(".js"));
for (const f of files) {
  if (!order.includes(f)) {
    console.error(`エラー: ${f} が _order.json に含まれていません`);
    process.exit(1);
  }
}
for (const f of order) {
  if (!files.includes(f)) {
    console.error(`エラー: _order.json の ${f} が存在しません`);
    process.exit(1);
  }
}

const js = order
  .map((f) => `/* ===== ${f} ===== */\n` + fs.readFileSync(path.join(srcJs, f), "utf8"))
  .join("\n");

const template = fs.readFileSync(path.join(root, "src", "template.html"), "utf8");
const marker = "<!--@SCRIPTS-->";
if (!template.includes(marker)) {
  console.error(`エラー: template.html に ${marker} がありません`);
  process.exit(1);
}
if (js.includes("</script")) {
  console.error("エラー: JSソースに </script が含まれています（インライン化できません）");
  process.exit(1);
}
const html = template.replace(marker, "<script>\n" + js + "\n</script>");

const distDir = path.join(root, "dist");
fs.mkdirSync(distDir, { recursive: true });
const out = path.join(distDir, "zumen-check.html");
fs.writeFileSync(out, html);
console.log(`書き出しました: ${path.relative(process.cwd(), out)} (${(html.length / 1024).toFixed(1)} KB)`);
