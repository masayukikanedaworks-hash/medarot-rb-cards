// PDF 構文の字句解析とオブジェクト組み立て
// ファイル本体・xref・コンテントストリーム・CMap で共用する。
(function (ZC) {
  "use strict";

  class Name {
    constructor(n) {
      this.name = n;
    }
  }
  class Ref {
    constructor(num, gen) {
      this.num = num;
      this.gen = gen;
    }
  }
  class PStr {
    // PDF 文字列（リテラル/16進）。テキスト表示のためバイト列のまま保持する
    constructor(bytes) {
      this.bytes = bytes;
    }
  }

  function isWs(c) {
    return c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
  }
  function isDelim(c) {
    return (
      c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b ||
      c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25
    );
  }

  class Lexer {
    constructor(bytes, pos) {
      this.b = bytes;
      this.pos = pos || 0;
    }

    skipWs() {
      const b = this.b;
      for (;;) {
        while (this.pos < b.length && isWs(b[this.pos])) this.pos++;
        if (b[this.pos] === 0x25) {
          // % コメント: 行末まで
          while (this.pos < b.length && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++;
          continue;
        }
        return;
      }
    }

    readToken() {
      this.skipWs();
      const b = this.b;
      if (this.pos >= b.length) return null;
      const c = b[this.pos];
      if (c === 0x3c) {
        if (b[this.pos + 1] === 0x3c) {
          this.pos += 2;
          return { t: "<<" };
        }
        return { t: "str", v: this.readHexString() };
      }
      if (c === 0x3e) {
        if (b[this.pos + 1] === 0x3e) {
          this.pos += 2;
          return { t: ">>" };
        }
        this.pos++;
        return { t: "junk" };
      }
      if (c === 0x28) return { t: "str", v: this.readLiteralString() };
      if (c === 0x2f) return { t: "name", v: this.readName() };
      if (c === 0x5b) { this.pos++; return { t: "[" }; }
      if (c === 0x5d) { this.pos++; return { t: "]" }; }
      if (c === 0x7b) { this.pos++; return { t: "{" }; }
      if (c === 0x7d) { this.pos++; return { t: "}" }; }
      if (c === 0x29) { this.pos++; return { t: "junk" }; }
      if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) {
        return { t: "num", v: this.readNumber() };
      }
      const kw = this.readKeyword();
      return { t: "kw", v: kw };
    }

    readNumber() {
      const b = this.b;
      const start = this.pos;
      this.pos++;
      while (this.pos < b.length) {
        const c = b[this.pos];
        if ((c >= 0x30 && c <= 0x39) || c === 0x2e || c === 0x2b || c === 0x2d) this.pos++;
        else break;
      }
      const v = parseFloat(ZC.util.latin1(b, start, this.pos));
      return isFinite(v) ? v : 0;
    }

    readKeyword() {
      const b = this.b;
      const start = this.pos;
      while (this.pos < b.length && !isWs(b[this.pos]) && !isDelim(b[this.pos])) this.pos++;
      if (this.pos === start) this.pos++; // 不正バイトで停止しない
      return ZC.util.latin1(b, start, this.pos);
    }

    readName() {
      const b = this.b;
      this.pos++; // '/'
      let s = "";
      while (this.pos < b.length && !isWs(b[this.pos]) && !isDelim(b[this.pos])) {
        let c = b[this.pos];
        if (c === 0x23 && this.pos + 2 < b.length) {
          const h = parseInt(ZC.util.latin1(b, this.pos + 1, this.pos + 3), 16);
          if (isFinite(h)) {
            s += String.fromCharCode(h);
            this.pos += 3;
            continue;
          }
        }
        s += String.fromCharCode(c);
        this.pos++;
      }
      return s;
    }

    readLiteralString() {
      const b = this.b;
      this.pos++; // '('
      const out = [];
      let depth = 1;
      while (this.pos < b.length) {
        let c = b[this.pos++];
        if (c === 0x5c) {
          // バックスラッシュエスケープ
          const e = b[this.pos++];
          switch (e) {
            case 0x6e: out.push(10); break; // \n
            case 0x72: out.push(13); break; // \r
            case 0x74: out.push(9); break;  // \t
            case 0x62: out.push(8); break;  // \b
            case 0x66: out.push(12); break; // \f
            case 0x28: out.push(0x28); break;
            case 0x29: out.push(0x29); break;
            case 0x5c: out.push(0x5c); break;
            case 13: if (b[this.pos] === 10) this.pos++; break; // 行継続
            case 10: break;
            default:
              if (e >= 0x30 && e <= 0x37) {
                // 8進数 1〜3桁
                let v = e - 0x30;
                for (let k = 0; k < 2; k++) {
                  const d = b[this.pos];
                  if (d >= 0x30 && d <= 0x37) {
                    v = v * 8 + (d - 0x30);
                    this.pos++;
                  } else break;
                }
                out.push(v & 0xff);
              } else if (e !== undefined) out.push(e);
          }
          continue;
        }
        if (c === 0x28) depth++;
        if (c === 0x29) {
          depth--;
          if (depth === 0) break;
        }
        if (c === 13) {
          // CR / CRLF は LF に正規化
          if (b[this.pos] === 10) this.pos++;
          c = 10;
        }
        out.push(c);
      }
      return new Uint8Array(out);
    }

    readHexString() {
      const b = this.b;
      this.pos++; // '<'
      const out = [];
      let hi = -1;
      while (this.pos < b.length) {
        const c = b[this.pos++];
        if (c === 0x3e) break;
        let d = -1;
        if (c >= 0x30 && c <= 0x39) d = c - 0x30;
        else if (c >= 0x41 && c <= 0x46) d = c - 0x41 + 10;
        else if (c >= 0x61 && c <= 0x66) d = c - 0x61 + 10;
        else continue;
        if (hi < 0) hi = d;
        else {
          out.push(hi * 16 + d);
          hi = -1;
        }
      }
      if (hi >= 0) out.push(hi * 16); // 奇数桁は 0 詰め
      return new Uint8Array(out);
    }
  }

  // トークン列から PDF オブジェクトを組み立てる。
  // allowRefs=false ならコンテントストリーム用（"n n R" の先読みをしない）。
  class ObjParser {
    constructor(lexer, opts) {
      this.lex = lexer;
      this.allowRefs = !opts || opts.refs !== false;
    }

    // EOF は undefined、null オブジェクトは null を返す
    parse() {
      return this.parseFrom(this.lex.readToken());
    }

    parseFrom(tok) {
      if (!tok) return undefined;
      switch (tok.t) {
        case "num": {
          if (this.allowRefs && Number.isInteger(tok.v) && tok.v >= 0) {
            const save = this.lex.pos;
            const t2 = this.lex.readToken();
            if (t2 && t2.t === "num" && Number.isInteger(t2.v) && t2.v >= 0) {
              const t3 = this.lex.readToken();
              if (t3 && t3.t === "kw" && t3.v === "R") return new Ref(tok.v, t2.v);
            }
            this.lex.pos = save;
          }
          return tok.v;
        }
        case "str":
          return new PStr(tok.v);
        case "name":
          return new Name(tok.v);
        case "[": {
          const arr = [];
          for (;;) {
            const t = this.lex.readToken();
            if (!t || t.t === "]") break;
            const v = this.parseFrom(t);
            if (v !== undefined) arr.push(v);
          }
          return arr;
        }
        case "<<": {
          const dict = Object.create(null);
          for (;;) {
            const t = this.lex.readToken();
            if (!t || t.t === ">>") break;
            if (t.t !== "name") {
              this.parseFrom(t); // 壊れたキーは読み捨て
              continue;
            }
            const v = this.parse();
            if (v !== undefined) dict[t.v] = v;
          }
          return dict;
        }
        case "kw":
          if (tok.v === "true") return true;
          if (tok.v === "false") return false;
          if (tok.v === "null") return null;
          return { op: tok.v };
        default:
          return { op: tok.t };
      }
    }
  }

  ZC.syntax = { Lexer, ObjParser, Name, Ref, PStr, isWs, isDelim };
})(globalThis.ZC = globalThis.ZC || {});
