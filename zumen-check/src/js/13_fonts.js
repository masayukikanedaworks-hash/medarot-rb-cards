// フォント: 文字コード→Unicode 変換（ToUnicode CMap / 単純エンコーディング）と字幅
(function (ZC) {
  "use strict";

  const { Lexer, Name } = ZC.syntax;
  const { PDFStream } = ZC.pdf;

  // グリフ名 → 文字（通り芯符号・寸法値の読み取りに必要な範囲のみ）
  const GLYPH_NAMES = {
    space: " ", period: ".", comma: ",", hyphen: "-", minus: "-", endash: "-",
    slash: "/", colon: ":", semicolon: ";", plus: "+", equal: "=", underscore: "_",
    parenleft: "(", parenright: ")", asterisk: "*", numbersign: "#", at: "@",
    zero: "0", one: "1", two: "2", three: "3", four: "4",
    five: "5", six: "6", seven: "7", eight: "8", nine: "9",
  };

  function glyphToChar(name) {
    if (!name) return "";
    if (GLYPH_NAMES[name] !== undefined) return GLYPH_NAMES[name];
    if (name.length === 1) return name;
    let m = /^uni([0-9A-Fa-f]{4})$/.exec(name);
    if (m) return String.fromCharCode(parseInt(m[1], 16));
    m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
    if (m) return String.fromCodePoint(parseInt(m[1], 16));
    return "";
  }

  function bytesToInt(b) {
    let v = 0;
    for (let i = 0; i < b.length; i++) v = v * 256 + b[i];
    return v;
  }

  function utf16beToStr(b) {
    let s = "";
    for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(b[i] * 256 + b[i + 1]);
    if (b.length === 1) s += String.fromCharCode(b[0]);
    return s;
  }

  // ToUnicode CMap を解析して {map, codeLens} を返す
  function parseToUnicodeCMap(bytes) {
    const map = new Map();
    const lens = new Set();
    const lex = new Lexer(bytes);
    const toks = [];
    for (;;) {
      const t = lex.readToken();
      if (!t) break;
      toks.push(t);
    }
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.t !== "kw") continue;
      if (t.v === "begincodespacerange") {
        for (i++; i < toks.length && !(toks[i].t === "kw" && toks[i].v === "endcodespacerange"); i += 2) {
          if (toks[i].t === "str") lens.add(toks[i].v.length);
        }
      } else if (t.v === "beginbfchar") {
        for (i++; i < toks.length && !(toks[i].t === "kw" && toks[i].v === "endbfchar"); i += 2) {
          const src = toks[i];
          const dst = toks[i + 1];
          if (src && dst && src.t === "str" && dst.t === "str") {
            map.set(bytesToInt(src.v), utf16beToStr(dst.v));
            lens.add(src.v.length);
          }
        }
      } else if (t.v === "beginbfrange") {
        i++;
        while (i < toks.length && !(toks[i].t === "kw" && toks[i].v === "endbfrange")) {
          const lo = toks[i++];
          const hi = toks[i++];
          if (!lo || !hi || lo.t !== "str" || hi.t !== "str") break;
          lens.add(lo.v.length);
          const loV = bytesToInt(lo.v);
          const hiV = Math.min(bytesToInt(hi.v), loV + 65535);
          const dst = toks[i++];
          if (dst && dst.t === "[") {
            // 配列形式: 各コードに個別の文字列
            let k = 0;
            while (i < toks.length && toks[i].t !== "]") {
              if (toks[i].t === "str") map.set(loV + k++, utf16beToStr(toks[i].v));
              i++;
            }
            i++; // ']'
          } else if (dst && dst.t === "str") {
            const base = utf16beToStr(dst.v);
            for (let c = loV; c <= hiV; c++) {
              const d = c - loV;
              if (base.length === 0) continue;
              // 最後のコードユニットに加算する
              const lastCode = base.charCodeAt(base.length - 1) + d;
              map.set(c, base.slice(0, -1) + String.fromCharCode(lastCode));
            }
          }
        }
      }
    }
    return { map, codeLens: Array.from(lens).sort((a, b) => b - a) };
  }

  class Font {
    constructor() {
      this.isType0 = false;
      this.toUni = null; // Map<code, string>
      this.codeLens = [1];
      this.simpleMap = null; // code -> char（Differences 由来）
      this.widths = null; // Map<code, width(1/1000)>
      this.defaultWidth = 500;
      this.firstChar = 0;
      this.widthArr = null;
    }

    static async build(doc, fontDictRef) {
      const f = new Font();
      const dict = await doc.deref(fontDictRef);
      if (!dict || typeof dict !== "object") return f;
      const subtype = dict.Subtype instanceof Name ? dict.Subtype.name : "";
      f.isType0 = subtype === "Type0";

      const tu = await doc.deref(dict.ToUnicode);
      if (tu instanceof PDFStream) {
        try {
          const parsed = parseToUnicodeCMap(await tu.data());
          if (parsed.map.size) {
            f.toUni = parsed.map;
            if (parsed.codeLens.length) f.codeLens = parsed.codeLens;
          }
        } catch (e) { /* ToUnicode 無しとして続行 */ }
      }

      if (f.isType0) {
        if (!f.toUni) f.codeLens = [2];
        f.defaultWidth = 1000;
        const desc = await doc.deref(dict.DescendantFonts);
        const d0 = Array.isArray(desc) ? await doc.deref(desc[0]) : null;
        if (d0) {
          const dw = await doc.deref(d0.DW);
          if (typeof dw === "number") f.defaultWidth = dw;
          const w = await doc.deref(d0.W);
          if (Array.isArray(w)) {
            f.widths = new Map();
            for (let i = 0; i < w.length; ) {
              const c1 = await doc.deref(w[i++]);
              const next = await doc.deref(w[i++]);
              if (Array.isArray(next)) {
                for (let k = 0; k < next.length; k++) {
                  const wv = await doc.deref(next[k]);
                  if (typeof wv === "number") f.widths.set(c1 + k, wv);
                }
              } else if (typeof next === "number") {
                const c2 = next;
                const wv = await doc.deref(w[i++]);
                if (typeof wv === "number") {
                  for (let c = c1; c <= Math.min(c2, c1 + 65535); c++) f.widths.set(c, wv);
                }
              }
            }
          }
        }
      } else {
        // 単純フォント
        const enc = await doc.deref(dict.Encoding);
        if (enc && typeof enc === "object" && !(enc instanceof Name)) {
          const diffs = await doc.deref(enc.Differences);
          if (Array.isArray(diffs)) {
            f.simpleMap = new Map();
            let code = 0;
            for (const item of diffs) {
              const v = await doc.deref(item);
              if (typeof v === "number") code = v;
              else if (v instanceof Name) f.simpleMap.set(code++, glyphToChar(v.name));
            }
          }
        }
        const fc = await doc.deref(dict.FirstChar);
        const widths = await doc.deref(dict.Widths);
        if (typeof fc === "number" && Array.isArray(widths)) {
          f.firstChar = fc;
          f.widthArr = [];
          for (const wv of widths) {
            const n = await doc.deref(wv);
            f.widthArr.push(typeof n === "number" ? n : f.defaultWidth);
          }
        }
      }
      return f;
    }

    width(code) {
      if (this.widths) {
        const w = this.widths.get(code);
        return w !== undefined ? w : this.defaultWidth;
      }
      if (this.widthArr) {
        const w = this.widthArr[code - this.firstChar];
        return w !== undefined ? w : this.defaultWidth;
      }
      return this.defaultWidth;
    }

    // 表示文字列のバイト列 → [{code, str, w0}] （w0 は 1/1000 単位の字幅）
    decode(bytes) {
      const out = [];
      let i = 0;
      while (i < bytes.length) {
        let code = -1;
        let used = 1;
        if (this.toUni) {
          // codespace の長い順に一致を試す
          for (const len of this.codeLens) {
            if (i + len > bytes.length) continue;
            const c = bytesToInt(bytes.subarray(i, i + len));
            if (this.toUni.has(c) || len === this.codeLens[this.codeLens.length - 1]) {
              code = c;
              used = len;
              break;
            }
          }
          if (code < 0) {
            code = bytes[i];
            used = 1;
          }
        } else if (this.isType0) {
          code = bytesToInt(bytes.subarray(i, Math.min(i + 2, bytes.length)));
          used = 2;
        } else {
          code = bytes[i];
          used = 1;
        }
        i += used;
        let str = "";
        if (this.toUni && this.toUni.has(code)) str = this.toUni.get(code);
        else if (this.simpleMap && this.simpleMap.has(code)) str = this.simpleMap.get(code);
        else if (!this.isType0 && code >= 32 && code < 127) str = String.fromCharCode(code);
        out.push({ code, str, w0: this.width(code) });
      }
      return out;
    }
  }

  ZC.fonts = { Font, parseToUnicodeCMap, glyphToChar };
})(globalThis.ZC = globalThis.ZC || {});
