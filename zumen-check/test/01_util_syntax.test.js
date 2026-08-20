// ユーティリティと PDF 構文パーサの単体テスト
"use strict";

const { assert } = require("./helpers");

exports.ラベル正規化 = () => {
  assert.equal(ZC.util.normalizeLabel("Ｘ１"), "X1");
  assert.equal(ZC.util.normalizeLabel(" y 2 "), "Y2");
  assert.equal(ZC.util.normalizeLabel("Ｙ１０"), "Y10");
};

exports.寸法値パース = () => {
  assert.equal(ZC.util.parseDimNumber("6,000"), 6000);
  assert.equal(ZC.util.parseDimNumber("６０００"), 6000);
  assert.equal(ZC.util.parseDimNumber("60"), null); // 桁不足
  assert.equal(ZC.util.parseDimNumber("123456"), null); // 桁過多
  assert.equal(ZC.util.parseDimNumber("X1"), null);
};

exports.符号判定 = () => {
  assert.equal(ZC.util.isAxisLabel("X1"), true);
  assert.equal(ZC.util.isAxisLabel("Y10"), true);
  assert.equal(ZC.util.isAxisLabel("A"), true);
  assert.equal(ZC.util.isAxisLabel("12"), true);
  assert.equal(ZC.util.isAxisLabel("123"), false); // 3桁の純数字は寸法値
  assert.equal(ZC.util.isAxisLabel("6000"), false);
  assert.equal(ZC.util.isAxisLabel(""), false);
};

exports.行列 = () => {
  const M = ZC.util.MAT;
  const m = M.mul(M.translate(10, 20), [2, 0, 0, 2, 0, 0]); // 平行移動→2倍
  const p = M.apply(m, 1, 1);
  assert.deepEqual(p, [22, 42]);
  assert.equal(M.scaleOf([2, 0, 0, 2, 5, 6]), 2);
};

function parseStr(s) {
  const bytes = new TextEncoder().encode(s);
  const lex = new ZC.syntax.Lexer(bytes);
  return new ZC.syntax.ObjParser(lex).parse();
}

exports.辞書と配列 = () => {
  const d = parseStr("<< /Name#20A (str) /N 3 0 R /Arr [1 2.5 -3 <414243>] /T true >>");
  assert.equal(Object.keys(d).length, 4);
  assert.ok(d["Name A"] instanceof ZC.syntax.PStr);
  assert.ok(d.N instanceof ZC.syntax.Ref);
  assert.equal(d.N.num, 3);
  assert.equal(d.Arr[0], 1);
  assert.equal(d.Arr[1], 2.5);
  assert.equal(d.Arr[2], -3);
  assert.deepEqual(Array.from(d.Arr[3].bytes), [0x41, 0x42, 0x43]);
  assert.equal(d.T, true);
};

exports.リテラル文字列 = () => {
  const v = parseStr("(a\\(b\\)c (nest) \\101 \\n)");
  const s = String.fromCharCode(...v.bytes);
  assert.equal(s, "a(b)c (nest) A \n");
};

exports.コメントと参照でない数値 = () => {
  const lex = new ZC.syntax.Lexer(new TextEncoder().encode("% comment\n[1 2 3]"));
  const v = new ZC.syntax.ObjParser(lex).parse();
  assert.deepEqual(v, [1, 2, 3]); // "1 2 R" ではないので数値のまま
};

exports.奇数桁の16進文字列 = () => {
  const v = parseStr("<41424>");
  assert.deepEqual(Array.from(v.bytes), [0x41, 0x42, 0x40]);
};
