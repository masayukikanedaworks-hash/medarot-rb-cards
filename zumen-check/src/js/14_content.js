// コンテントストリーム解釈: 線分とテキストをデバイス座標（表示向き・pt）で抽出する
(function (ZC) {
  "use strict";

  const { Lexer, ObjParser, Name, PStr } = ZC.syntax;
  const { PDFStream } = ZC.pdf;
  const MAT = ZC.util.MAT;

  const BEZIER_STEPS = 8; // 曲線の折れ線近似の分割数
  const MAX_FORM_DEPTH = 8;

  class ContentExtractor {
    constructor(doc) {
      this.doc = doc;
      this.segments = []; // {x1,y1,x2,y2,w,dashed,curve}
      this.texts = []; // {str,x,y,ex,ey,size}
      this.imageCount = 0;
      this._fontCache = new Map();
    }

    // page: PDFDocument.getPages() の要素
    async run(page) {
      const mb = normBox(await this.doc.deref(page.MediaBox)) || [0, 0, 612, 792];
      let box = normBox(await this.doc.deref(page.CropBox)) || mb;
      // CropBox は MediaBox と交差させる
      box = [
        Math.max(box[0], mb[0]),
        Math.max(box[1], mb[1]),
        Math.min(box[2], mb[2]),
        Math.min(box[3], mb[3]),
      ];
      if (!(box[2] > box[0] && box[3] > box[1])) box = mb;
      const w = box[2] - box[0];
      const h = box[3] - box[1];
      let rot = await this.doc.deref(page.Rotate);
      rot = typeof rot === "number" ? ((rot % 360) + 360) % 360 : 0;
      // ページ原点補正 + /Rotate の表示向き変換
      let base = MAT.translate(-box[0], -box[1]);
      let outW = w;
      let outH = h;
      if (rot === 90) {
        base = MAT.mul(base, [0, -1, 1, 0, 0, w]);
        outW = h;
        outH = w;
      } else if (rot === 180) {
        base = MAT.mul(base, [-1, 0, 0, -1, w, h]);
      } else if (rot === 270) {
        base = MAT.mul(base, [0, 1, -1, 0, h, 0]);
        outW = h;
        outH = w;
      }
      const resources = await this.doc.deref(page.Resources);
      const content = await this.doc.getPageContentBytes(page);
      await this._exec(content, { ctm: base, w: 1, dashed: false }, resources || {}, 0);
      return {
        segments: this.segments,
        texts: this.texts,
        width: outW,
        height: outH,
        rotate: rot,
        imageCount: this.imageCount,
      };
    }

    async _exec(bytes, initGs, resources, depth) {
      const doc = this.doc;
      const lex = new Lexer(bytes);
      const parser = new ObjParser(lex, { refs: false });
      let gs = { ctm: initGs.ctm.slice(), w: initGs.w, dashed: initGs.dashed };
      const gsStack = [];
      let ops = [];

      // パス構築: subpath = [{x,y,curve}] の配列
      let subpaths = [];
      let cur = null;
      let lastPt = null;

      // テキスト状態
      let tm = MAT.id();
      let tlm = MAT.id();
      let font = null;
      let tfs = 0;
      let tc = 0;
      let tw = 0;
      let th = 1;
      let tl = 0;
      let trise = 0;

      const moveTo = (x, y) => {
        const p = MAT.apply(gs.ctm, x, y);
        cur = [{ x: p[0], y: p[1], curve: false }];
        subpaths.push(cur);
        lastPt = { x, y };
      };
      const lineTo = (x, y, curve) => {
        if (!cur) moveTo(x, y);
        else {
          const p = MAT.apply(gs.ctm, x, y);
          cur.push({ x: p[0], y: p[1], curve: !!curve });
          lastPt = { x, y };
        }
      };
      const curveTo = (x1, y1, x2, y2, x3, y3) => {
        if (!lastPt) {
          moveTo(x3, y3);
          return;
        }
        const p0 = lastPt;
        for (let i = 1; i <= BEZIER_STEPS; i++) {
          const t = i / BEZIER_STEPS;
          const u = 1 - t;
          const x = u * u * u * p0.x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3;
          const y = u * u * u * p0.y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3;
          lineTo(x, y, true);
        }
        lastPt = { x: x3, y: y3 };
      };
      const closePath = () => {
        if (cur && cur.length > 1) cur.push({ x: cur[0].x, y: cur[0].y, curve: false });
      };
      const clearPath = () => {
        subpaths = [];
        cur = null;
        lastPt = null;
      };
      const strokePath = () => {
        const wDev = gs.w * MAT.scaleOf(gs.ctm);
        for (const sp of subpaths) {
          for (let i = 1; i < sp.length; i++) {
            const a = sp[i - 1];
            const b = sp[i];
            if (a.x === b.x && a.y === b.y) continue;
            this.segments.push({
              x1: a.x, y1: a.y, x2: b.x, y2: b.y,
              w: wDev, dashed: gs.dashed, curve: b.curve,
            });
          }
        }
        clearPath();
      };

      const showText = (strObj) => {
        if (!(strObj instanceof PStr) || tfs === 0) return;
        const glyphs = font ? font.decode(strObj.bytes) : fallbackDecode(strObj.bytes);
        if (!glyphs.length) return;
        const trm0 = MAT.mul(MAT.mul([tfs * th, 0, 0, tfs, 0, trise], tm), gs.ctm);
        const start = [trm0[4], trm0[5]];
        const size = tfs * MAT.scaleOf(MAT.mul(tm, gs.ctm));
        let str = "";
        for (const gph of glyphs) {
          str += gph.str;
          const isSpace = !font || !font.isType0 ? gph.code === 32 : false;
          const adv = ((gph.w0 / 1000) * tfs + tc + (isSpace ? tw : 0)) * th;
          tm = MAT.mul(MAT.translate(adv, 0), tm);
        }
        const trm1 = MAT.mul(MAT.mul([tfs * th, 0, 0, tfs, 0, trise], tm), gs.ctm);
        if (str.trim().length) {
          this.texts.push({ str, x: start[0], y: start[1], ex: trm1[4], ey: trm1[5], size });
        }
      };

      const nums = (n) => {
        const a = [];
        for (let i = ops.length - n; i < ops.length; i++) {
          const v = ops[i];
          a.push(typeof v === "number" ? v : 0);
        }
        return a;
      };

      for (;;) {
        const v = parser.parse();
        if (v === undefined) break;
        if (!v || typeof v !== "object" || !("op" in v)) {
          ops.push(v);
          if (ops.length > 64) ops.splice(0, ops.length - 64);
          continue;
        }
        const op = v.op;
        switch (op) {
          case "q":
            gsStack.push({ ctm: gs.ctm.slice(), w: gs.w, dashed: gs.dashed });
            break;
          case "Q":
            if (gsStack.length) gs = gsStack.pop();
            break;
          case "cm": {
            const m = nums(6);
            gs.ctm = MAT.mul(m, gs.ctm);
            break;
          }
          case "w":
            gs.w = nums(1)[0];
            break;
          case "d": {
            // 破線パターン: 配列に正の値があれば破線とみなす
            const arr = ops[ops.length - 2];
            gs.dashed = Array.isArray(arr) && arr.length > 0 && arr.some((x) => typeof x === "number" && x > 0);
            break;
          }
          case "m": {
            const [x, y] = nums(2);
            moveTo(x, y);
            break;
          }
          case "l": {
            const [x, y] = nums(2);
            lineTo(x, y, false);
            break;
          }
          case "c": {
            const [x1, y1, x2, y2, x3, y3] = nums(6);
            curveTo(x1, y1, x2, y2, x3, y3);
            break;
          }
          case "v": {
            const [x2, y2, x3, y3] = nums(4);
            const p0 = lastPt || { x: x2, y: y2 };
            curveTo(p0.x, p0.y, x2, y2, x3, y3);
            break;
          }
          case "y": {
            const [x1, y1, x3, y3] = nums(4);
            curveTo(x1, y1, x3, y3, x3, y3);
            break;
          }
          case "h":
            closePath();
            break;
          case "re": {
            const [x, y, rw, rh] = nums(4);
            moveTo(x, y);
            lineTo(x + rw, y, false);
            lineTo(x + rw, y + rh, false);
            lineTo(x, y + rh, false);
            closePath();
            break;
          }
          case "S":
            strokePath();
            break;
          case "s":
            closePath();
            strokePath();
            break;
          case "B":
          case "B*":
          case "b":
          case "b*":
            if (op === "b" || op === "b*") closePath();
            strokePath();
            break;
          case "f":
          case "F":
          case "f*":
          case "n":
            clearPath();
            break;
          case "BT":
            tm = MAT.id();
            tlm = MAT.id();
            break;
          case "ET":
            break;
          case "Tf": {
            const size = ops[ops.length - 1];
            const nameObj = ops[ops.length - 2];
            tfs = typeof size === "number" ? size : 0;
            font = null;
            if (nameObj instanceof Name && resources) {
              const fonts = await doc.deref(resources.Font);
              if (fonts && fonts[nameObj.name] !== undefined) {
                const fref = fonts[nameObj.name];
                const key = fref && fref.num !== undefined ? "R" + fref.num + "_" + fref.gen : fref;
                if (this._fontCache.has(key)) font = this._fontCache.get(key);
                else {
                  font = await ZC.fonts.Font.build(doc, fref);
                  this._fontCache.set(key, font);
                }
              }
            }
            break;
          }
          case "Td": {
            const [tx, ty] = nums(2);
            tlm = MAT.mul(MAT.translate(tx, ty), tlm);
            tm = tlm.slice();
            break;
          }
          case "TD": {
            const [tx, ty] = nums(2);
            tl = -ty;
            tlm = MAT.mul(MAT.translate(tx, ty), tlm);
            tm = tlm.slice();
            break;
          }
          case "Tm": {
            tlm = nums(6);
            tm = tlm.slice();
            break;
          }
          case "T*":
            tlm = MAT.mul(MAT.translate(0, -tl), tlm);
            tm = tlm.slice();
            break;
          case "TL":
            tl = nums(1)[0];
            break;
          case "Tc":
            tc = nums(1)[0];
            break;
          case "Tw":
            tw = nums(1)[0];
            break;
          case "Tz":
            th = nums(1)[0] / 100;
            break;
          case "Ts":
            trise = nums(1)[0];
            break;
          case "Tj":
            showText(ops[ops.length - 1]);
            break;
          case "'":
            tlm = MAT.mul(MAT.translate(0, -tl), tlm);
            tm = tlm.slice();
            showText(ops[ops.length - 1]);
            break;
          case '"': {
            const aw = ops[ops.length - 3];
            const ac = ops[ops.length - 2];
            if (typeof aw === "number") tw = aw;
            if (typeof ac === "number") tc = ac;
            tlm = MAT.mul(MAT.translate(0, -tl), tlm);
            tm = tlm.slice();
            showText(ops[ops.length - 1]);
            break;
          }
          case "TJ": {
            const arr = ops[ops.length - 1];
            if (Array.isArray(arr)) {
              // 1 つの TJ を 1 つのテキストランとして扱うため、開始位置を保存して連結する
              const parts = [];
              const startTm = tm.slice();
              const trm0 = MAT.mul(MAT.mul([tfs * th, 0, 0, tfs, 0, trise], startTm), gs.ctm);
              const size = tfs * MAT.scaleOf(MAT.mul(startTm, gs.ctm));
              let str = "";
              for (const el of arr) {
                if (typeof el === "number") {
                  tm = MAT.mul(MAT.translate((-el / 1000) * tfs * th, 0), tm);
                } else if (el instanceof PStr) {
                  const glyphs = font ? font.decode(el.bytes) : fallbackDecode(el.bytes);
                  for (const gph of glyphs) {
                    str += gph.str;
                    const isSpace = !font || !font.isType0 ? gph.code === 32 : false;
                    const adv = ((gph.w0 / 1000) * tfs + tc + (isSpace ? tw : 0)) * th;
                    tm = MAT.mul(MAT.translate(adv, 0), tm);
                  }
                }
              }
              const trm1 = MAT.mul(MAT.mul([tfs * th, 0, 0, tfs, 0, trise], tm), gs.ctm);
              if (str.trim().length) {
                this.texts.push({ str, x: trm0[4], y: trm0[5], ex: trm1[4], ey: trm1[5], size });
              }
            }
            break;
          }
          case "Do": {
            const nameObj = ops[ops.length - 1];
            if (nameObj instanceof Name && resources && depth < MAX_FORM_DEPTH) {
              const xobjects = await doc.deref(resources.XObject);
              if (xobjects && xobjects[nameObj.name] !== undefined) {
                const xo = await doc.deref(xobjects[nameObj.name]);
                if (xo instanceof PDFStream) {
                  const st = xo.dict.Subtype instanceof Name ? xo.dict.Subtype.name : "";
                  if (st === "Image") {
                    this.imageCount++;
                  } else if (st === "Form") {
                    let data = null;
                    try {
                      data = await xo.data();
                    } catch (e) {
                      if (e && e.message !== "IMAGE_FILTER") data = null;
                    }
                    if (data) {
                      const mtx = await doc.deref(xo.dict.Matrix);
                      const ctm2 = Array.isArray(mtx) && mtx.length === 6 ? MAT.mul(mtx.map(Number), gs.ctm) : gs.ctm;
                      const res2 = (await doc.deref(xo.dict.Resources)) || resources;
                      await this._exec(data, { ctm: ctm2, w: gs.w, dashed: gs.dashed }, res2, depth + 1);
                    }
                  }
                }
              }
            }
            break;
          }
          case "BI": {
            // インライン画像: ID までのキー値を読み飛ばし、EI を探す
            this.imageCount++;
            for (;;) {
              const t = parser.parse();
              if (t === undefined) break;
              if (t && typeof t === "object" && t.op === "ID") break;
            }
            let p = lex.pos + 1;
            const b = bytes;
            let found = -1;
            for (; p + 1 < b.length; p++) {
              if (
                b[p] === 0x45 && b[p + 1] === 0x49 &&
                ZC.syntax.isWs(b[p - 1]) &&
                (p + 2 >= b.length || ZC.syntax.isWs(b[p + 2]) || ZC.syntax.isDelim(b[p + 2]))
              ) {
                found = p;
                break;
              }
            }
            if (found < 0) {
              lex.pos = b.length;
            } else {
              lex.pos = found + 2;
            }
            break;
          }
          default:
            // 色・クリップ・マークコンテント等は無視
            break;
        }
        ops = [];
      }
    }
  }

  // フォント情報が取れないときの素朴なデコード（ASCII 前提）
  function fallbackDecode(bytes) {
    const out = [];
    for (let i = 0; i < bytes.length; i++) {
      const c = bytes[i];
      out.push({ code: c, str: c >= 32 && c < 127 ? String.fromCharCode(c) : "", w0: 500 });
    }
    return out;
  }

  function normBox(box) {
    if (!Array.isArray(box) || box.length < 4) return null;
    const n = box.map(Number);
    if (n.some((x) => !isFinite(x))) return null;
    return [Math.min(n[0], n[2]), Math.min(n[1], n[3]), Math.max(n[0], n[2]), Math.max(n[1], n[3])];
  }

  ZC.content = { ContentExtractor };
})(globalThis.ZC = globalThis.ZC || {});
