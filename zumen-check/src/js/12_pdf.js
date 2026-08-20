// PDF ドキュメント層: xref（表/ストリーム両対応）、オブジェクト解決、ページ列挙
(function (ZC) {
  "use strict";

  const { Lexer, ObjParser, Name, Ref } = ZC.syntax;
  const U = ZC.util;

  class PDFError extends Error {}

  class PDFStream {
    constructor(doc, dict, raw) {
      this.doc = doc;
      this.dict = dict;
      this.raw = raw;
      this._data = null;
    }
    async data() {
      if (!this._data) this._data = await this.doc._decodeStream(this);
      return this._data;
    }
  }

  class PDFDocument {
    constructor(bytes) {
      this.bytes = bytes;
      this.xref = new Map(); // objNum -> {offset,gen} | {stm,idx}
      this.trailer = Object.create(null);
      this.cache = new Map();
      this.objStmCache = new Map();
      this._rescanned = false;
    }

    static async load(bytes) {
      if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
      const doc = new PDFDocument(bytes);
      await doc._init();
      return doc;
    }

    async _init() {
      if (U.latin1(this.bytes, 0, Math.min(1024, this.bytes.length)).indexOf("%PDF") < 0) {
        throw new PDFError("PDFファイルではありません。");
      }
      let ok = false;
      const tailStart = Math.max(0, this.bytes.length - 2048);
      const tail = U.latin1(this.bytes, tailStart);
      const sx = tail.lastIndexOf("startxref");
      if (sx >= 0) {
        const m = tail.slice(sx + 9).match(/\d+/);
        if (m) {
          try {
            await this._readXrefChain(Number(m[0]));
            ok = this.xref.size > 0 && this.trailer.Root !== undefined;
          } catch (e) {
            ok = false;
          }
        }
      }
      if (!ok) await this._rebuildByScan();
      if (this.trailer.Encrypt !== undefined) {
        throw new PDFError("暗号化されたPDFには対応していません。パスワードを外したPDFを使用してください。");
      }
      if (this.trailer.Root === undefined) {
        throw new PDFError("PDFの構造を読み取れませんでした。");
      }
    }

    async _readXrefChain(offset) {
      const seen = new Set();
      const queue = [offset];
      while (queue.length) {
        const off = queue.shift();
        if (off == null || seen.has(off) || off < 0 || off >= this.bytes.length) continue;
        seen.add(off);
        const trailer = await this._readXrefAt(off);
        for (const k of Object.keys(trailer)) {
          if (this.trailer[k] === undefined) this.trailer[k] = trailer[k];
        }
        // ハイブリッド参照 → 旧版の順で辿る（新しいエントリ優先で登録済みのため上書きしない）
        if (typeof trailer.XRefStm === "number") queue.push(trailer.XRefStm);
        if (typeof trailer.Prev === "number") queue.push(trailer.Prev);
      }
    }

    async _readXrefAt(off) {
      const lex = new Lexer(this.bytes, off);
      const first = lex.readToken();
      if (first && first.t === "kw" && first.v === "xref") {
        // クラシックな xref 表
        for (;;) {
          const a = lex.readToken();
          if (!a) throw new PDFError("xref表が途中で終わっています");
          if (a.t === "kw" && a.v === "trailer") break;
          const b = lex.readToken();
          if (!a || !b || a.t !== "num" || b.t !== "num") throw new PDFError("xref表が壊れています");
          const start = a.v;
          for (let i = 0; i < b.v; i++) {
            const f1 = lex.readToken();
            const f2 = lex.readToken();
            const f3 = lex.readToken();
            if (!f1 || !f2 || !f3) throw new PDFError("xref表が壊れています");
            const num = start + i;
            if (f3.v === "n" && !this.xref.has(num)) {
              this.xref.set(num, { offset: f1.v, gen: f2.v });
            }
          }
        }
        const trailer = new ObjParser(lex).parse();
        return trailer && typeof trailer === "object" ? trailer : {};
      }
      // xref ストリーム（PDF 1.5+）
      const { value } = await this._parseIndirectAt(off);
      if (!(value instanceof PDFStream)) throw new PDFError("xrefストリームが見つかりません");
      const dict = value.dict;
      const data = await value.data();
      const W = (Array.isArray(dict.W) ? dict.W : []).map(Number);
      if (W.length < 2) throw new PDFError("xrefストリームのWが不正です");
      const rowLen = W.reduce((a, b) => a + (b || 0), 0);
      let index;
      if (Array.isArray(dict.Index)) index = dict.Index.map(Number);
      else if (typeof dict.Size === "number") index = [0, dict.Size];
      else index = [0, Math.floor(data.length / rowLen)];
      let p = 0;
      const read = (w) => {
        let v = 0;
        for (let j = 0; j < w; j++) v = v * 256 + data[p++];
        return v;
      };
      for (let k = 0; k + 1 < index.length; k += 2) {
        const start = index[k];
        const count = index[k + 1];
        for (let i = 0; i < count && p + rowLen <= data.length; i++) {
          const type = W[0] ? read(W[0]) : 1;
          const f2 = read(W[1]);
          const f3 = W[2] ? read(W[2]) : 0;
          const num = start + i;
          if (this.xref.has(num)) continue;
          if (type === 1) this.xref.set(num, { offset: f2, gen: f3 });
          else if (type === 2) this.xref.set(num, { stm: f2, idx: f3 });
        }
      }
      return dict;
    }

    // xref が壊れている場合の総当たり再構築
    async _rebuildByScan() {
      this.cache.clear();
      this.objStmCache.clear();
      const s = U.latin1(this.bytes);
      const map = new Map();
      const re = /(\d{1,9})\s+(\d{1,5})\s+obj\b/g;
      let m;
      while ((m = re.exec(s))) {
        map.set(Number(m[1]), { offset: m.index, gen: Number(m[2]) });
      }
      // ObjStm 経由のエントリは既存の xref から引き継ぐ
      for (const [num, e] of this.xref) {
        if (!map.has(num)) map.set(num, e);
      }
      this.xref = map;
      // trailer を末尾から探す
      let ti = s.lastIndexOf("trailer");
      while (ti >= 0) {
        try {
          const t = new ObjParser(new Lexer(this.bytes, ti + 7)).parse();
          if (t && typeof t === "object") {
            for (const k of Object.keys(t)) {
              if (this.trailer[k] === undefined) this.trailer[k] = t[k];
            }
            if (this.trailer.Root !== undefined) break;
          }
        } catch (e) { /* 次の候補へ */ }
        ti = s.lastIndexOf("trailer", ti - 1);
      }
      if (this.trailer.Root === undefined) {
        // /Type /Catalog を持つオブジェクトを探す
        for (const [num] of this.xref) {
          let v = null;
          try {
            v = await this.getObj(num);
          } catch (e) { /* skip */ }
          const d = v instanceof PDFStream ? v.dict : v;
          if (d && d.Type instanceof Name && d.Type.name === "Catalog") {
            this.trailer.Root = new Ref(num, 0);
            break;
          }
        }
      }
    }

    async _parseIndirectAt(off, expectNum) {
      const lex = new Lexer(this.bytes, off);
      const t1 = lex.readToken();
      const t2 = lex.readToken();
      const t3 = lex.readToken();
      if (!t1 || !t2 || !t3 || t1.t !== "num" || t2.t !== "num" || !(t3.t === "kw" && t3.v === "obj")) {
        throw new PDFError("オブジェクトの位置がずれています");
      }
      if (expectNum != null && t1.v !== expectNum) {
        throw new PDFError("オブジェクト番号が一致しません");
      }
      let value = new ObjParser(lex).parse();
      // 直後に stream が続くか
      const save = lex.pos;
      const t4 = lex.readToken();
      if (t4 && t4.t === "kw" && t4.v === "stream" && value && typeof value === "object" && !Array.isArray(value)) {
        let p = lex.pos;
        if (this.bytes[p] === 13) p++;
        if (this.bytes[p] === 10) p++;
        let len = value.Length;
        if (len instanceof Ref) len = await this.deref(len);
        let end = -1;
        if (typeof len === "number" && len >= 0 && p + len <= this.bytes.length) {
          const probe = U.latin1(this.bytes, p + len, Math.min(this.bytes.length, p + len + 20));
          if (/^[\s]*endstream/.test(probe)) end = p + len;
        }
        if (end < 0) {
          // Length が信用できないので endstream を探す
          const es = U.indexOfBytes(this.bytes, "endstream", p);
          if (es < 0) throw new PDFError("endstreamが見つかりません");
          let e = es;
          if (this.bytes[e - 1] === 10) e--;
          if (this.bytes[e - 1] === 13) e--;
          end = e;
        }
        value = new PDFStream(this, value, this.bytes.subarray(p, end));
      } else {
        lex.pos = save;
      }
      return { num: t1.v, value };
    }

    async getObj(num) {
      if (this.cache.has(num)) return this.cache.get(num);
      const e = this.xref.get(num);
      let v = null;
      if (e) {
        try {
          if (e.offset != null) v = (await this._parseIndirectAt(e.offset, num)).value;
          else v = await this._getFromObjStm(e.stm, e.idx, num);
        } catch (err) {
          // オフセットずれ → 一度だけ全走査で復旧を試みる
          if (!this._rescanned) {
            this._rescanned = true;
            await this._rebuildByScan();
            const e2 = this.xref.get(num);
            if (e2 && e2.offset != null) {
              try {
                v = (await this._parseIndirectAt(e2.offset, num)).value;
              } catch (err2) {
                v = null;
              }
            }
          }
        }
      }
      this.cache.set(num, v);
      return v;
    }

    async _getFromObjStm(stmNum, idx, wantNum) {
      let table = this.objStmCache.get(stmNum);
      if (!table) {
        const stm = await this.getObj(stmNum);
        if (!(stm instanceof PDFStream)) throw new PDFError("オブジェクトストリームが読めません");
        const data = await stm.data();
        const n = await this.deref(stm.dict.N);
        const first = await this.deref(stm.dict.First);
        const lex = new Lexer(data);
        const heads = [];
        for (let i = 0; i < n; i++) {
          const a = lex.readToken();
          const b = lex.readToken();
          if (!a || !b) break;
          heads.push([a.v, b.v]);
        }
        table = heads.map(([objNum, rel]) => ({
          num: objNum,
          value: new ObjParser(new Lexer(data, first + rel)).parse(),
        }));
        this.objStmCache.set(stmNum, table);
      }
      let ent = table[idx];
      if (!ent || (wantNum != null && ent.num !== wantNum)) {
        ent = table.find((e2) => e2.num === wantNum);
      }
      return ent ? ent.value : null;
    }

    async deref(v) {
      let depth = 0;
      while (v instanceof Ref) {
        if (depth++ > 32) return null;
        v = await this.getObj(v.num);
      }
      return v;
    }

    async _decodeStream(stm) {
      let data = stm.raw;
      const filter = await this.deref(stm.dict.Filter);
      let parms = await this.deref(stm.dict.DecodeParms !== undefined ? stm.dict.DecodeParms : stm.dict.DP);
      const filters = filter == null ? [] : Array.isArray(filter) ? filter : [filter];
      const parmsArr = parms == null ? [] : Array.isArray(parms) ? parms : [parms];
      for (let i = 0; i < filters.length; i++) {
        const f = await this.deref(filters[i]);
        const name = f instanceof Name ? f.name : String(f);
        const pmRaw = (await this.deref(parmsArr[i])) || {};
        const pm = {};
        for (const k of ["Predictor", "Colors", "BitsPerComponent", "Columns"]) {
          pm[k] = await this.deref(pmRaw[k]);
        }
        data = await ZC.filters.decode(name, data, pm);
      }
      return data;
    }

    async getPages() {
      const root = await this.deref(this.trailer.Root);
      if (!root) throw new PDFError("ドキュメントカタログが読めません");
      const pages = [];
      const seen = new Set();
      const walk = async (ref, inh, depth) => {
        if (depth > 64 || pages.length > 2000) return;
        if (ref instanceof Ref) {
          const key = ref.num + "_" + ref.gen;
          if (seen.has(key)) return;
          seen.add(key);
        }
        const node = await this.deref(ref);
        if (!node || typeof node !== "object") return;
        const d = node instanceof PDFStream ? node.dict : node;
        const inherit = {
          Resources: d.Resources !== undefined ? d.Resources : inh.Resources,
          MediaBox: d.MediaBox !== undefined ? d.MediaBox : inh.MediaBox,
          CropBox: d.CropBox !== undefined ? d.CropBox : inh.CropBox,
          Rotate: d.Rotate !== undefined ? d.Rotate : inh.Rotate,
        };
        const type = d.Type instanceof Name ? d.Type.name : null;
        const kids = d.Kids !== undefined ? await this.deref(d.Kids) : null;
        if ((type === "Pages" || (Array.isArray(kids) && type !== "Page")) && Array.isArray(kids)) {
          for (const k of kids) await walk(k, inherit, depth + 1);
        } else if (type === "Page" || d.Contents !== undefined) {
          pages.push(Object.assign(Object.create(null), d, inherit));
        }
      };
      await walk(root.Pages, {}, 0);
      if (!pages.length) throw new PDFError("ページが見つかりませんでした");
      return pages;
    }

    async getPageContentBytes(page) {
      const c = await this.deref(page.Contents);
      const list = Array.isArray(c) ? c : c ? [c] : [];
      const parts = [];
      let total = 0;
      for (const item of list) {
        const s = await this.deref(item);
        if (s instanceof PDFStream) {
          try {
            const d = await s.data();
            parts.push(d);
            total += d.length + 1;
          } catch (e) {
            if (e && e.message === "IMAGE_FILTER") continue;
            // 壊れたストリームは飛ばして続行
          }
        }
      }
      const out = new Uint8Array(total);
      let p = 0;
      for (const part of parts) {
        out.set(part, p);
        p += part.length;
        out[p++] = 0x0a; // ストリーム境界の区切り
      }
      return out;
    }
  }

  ZC.pdf = { PDFDocument, PDFStream, PDFError };
})(globalThis.ZC = globalThis.ZC || {});
