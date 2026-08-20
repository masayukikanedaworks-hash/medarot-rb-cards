// ストリームフィルタの単体テスト
"use strict";

const zlib = require("node:zlib");
const { assert } = require("./helpers");

exports.FlateDecode = async () => {
  const orig = new TextEncoder().encode("0 0 m 100 100 l S ".repeat(50));
  const out = await ZC.filters.inflate(new Uint8Array(zlib.deflateSync(orig)));
  assert.deepEqual(Array.from(out), Array.from(orig));
};

exports.FlateDecode_末尾ゴミ耐性 = async () => {
  const orig = new TextEncoder().encode("hello pdf stream");
  const z = zlib.deflateSync(orig);
  const withJunk = new Uint8Array(z.length + 2);
  withJunk.set(z);
  withJunk[z.length] = 13;
  withJunk[z.length + 1] = 10;
  const out = await ZC.filters.inflate(withJunk);
  assert.equal(String.fromCharCode(...out), "hello pdf stream");
};

exports.PNG予測子Up = () => {
  // 2行 x 3列、フィルタ種別 2 (Up)
  const raw = [1, 2, 3, 4, 5, 6];
  const enc = new Uint8Array([2, 1, 2, 3, 2, 3, 3, 3]);
  const out = ZC.filters.applyPredictor(enc, { Predictor: 12, Colors: 1, BitsPerComponent: 8, Columns: 3 });
  assert.deepEqual(Array.from(out), raw);
};

exports.ASCIIHex = () => {
  const out = ZC.filters.asciiHexDecode(new TextEncoder().encode("48 65 6C6C6F>"));
  assert.equal(String.fromCharCode(...out), "Hello");
};

exports.ASCII85_zショートカット = () => {
  const out = ZC.filters.ascii85Decode(new TextEncoder().encode("z~>"));
  assert.deepEqual(Array.from(out), [0, 0, 0, 0]);
};

exports.RunLength = () => {
  const out = ZC.filters.runLengthDecode(new Uint8Array([2, 65, 66, 67, 254, 88, 128]));
  assert.equal(String.fromCharCode(...out), "ABCXXX");
};
