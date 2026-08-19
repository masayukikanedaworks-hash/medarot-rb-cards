// PDF ドキュメント層のテスト（xref・ページ・ストリーム・異常系）
"use strict";

const mk = require("./make_pdf");
const { assert } = require("./helpers");

exports.基本PDFの読み込み = async () => {
  const bytes = mk.makeBasicPdf();
  const doc = await ZC.pdf.PDFDocument.load(bytes);
  const pages = await doc.getPages();
  assert.equal(pages.length, 1);
  const mb = await doc.deref(pages[0].MediaBox);
  assert.deepEqual(mb.map(Number), [0, 0, 842, 595]);
  const content = await doc.getPageContentBytes(pages[0]);
  assert.ok(content.length > 100);
  assert.ok(ZC.util.latin1(content).includes(" re"));
  const res = await doc.deref(pages[0].Resources);
  const fonts = await doc.deref(res.Font);
  const f1 = await doc.deref(fonts.F1);
  assert.equal(f1.Type.name, "Font");
};

exports.非圧縮コンテントも読める = async () => {
  const bytes = mk.makeBasicPdf(null, { flate: false });
  const doc = await ZC.pdf.PDFDocument.load(bytes);
  const pages = await doc.getPages();
  const content = await doc.getPageContentBytes(pages[0]);
  assert.ok(ZC.util.latin1(content).includes("BT"));
};

exports.暗号化PDFは明示エラー = async () => {
  const bytes = mk.makeBasicPdf(null, { encrypt: true });
  await assert.rejects(() => ZC.pdf.PDFDocument.load(bytes), /暗号化/);
};

exports.startxref破損は全走査で復旧 = async () => {
  const bytes = mk.makeBasicPdf(null, { corruptStartxref: true });
  const doc = await ZC.pdf.PDFDocument.load(bytes);
  const pages = await doc.getPages();
  assert.equal(pages.length, 1);
  const content = await doc.getPageContentBytes(pages[0]);
  assert.ok(content.length > 100);
};

exports.PDFでないファイルはエラー = async () => {
  await assert.rejects(() => ZC.pdf.PDFDocument.load(new TextEncoder().encode("hello world, not a pdf")), /PDF/);
};
