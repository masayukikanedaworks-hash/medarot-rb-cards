// 汎用ユーティリティ（文字正規化・行列・数値）
(function (ZC) {
  "use strict";

  // 全角英数記号→半角に寄せ、空白を除去して大文字化する（通り芯符号の比較用）
  function normalizeLabel(s) {
    let out = "";
    for (const ch of String(s)) {
      const c = ch.codePointAt(0);
      if (c === 0x3000 || c === 0x20 || c === 9 || c === 10 || c === 13) continue;
      if (c >= 0xff01 && c <= 0xff5e) {
        out += String.fromCharCode(c - 0xfee0);
        continue;
      }
      out += ch;
    }
    return out.toUpperCase();
  }

  // 寸法値らしい文字列を mm 数値へ（"6,000" → 6000）。該当しなければ null
  function parseDimNumber(s) {
    const t = normalizeLabel(s).replace(/,/g, "");
    if (!/^\d{3,5}$/.test(t)) return null;
    const v = Number(t);
    return v >= 100 && v <= 99999 ? v : null;
  }

  // 通り芯符号らしい文字列か（X1 / Y10 / A / 3 など。3桁以上の純数字は寸法値とみなし除外）
  function isAxisLabel(norm) {
    if (!norm || norm.length > 4) return false;
    if (/^[0-9]{1,2}$/.test(norm)) return true;
    return /^[A-Z]{1,2}[0-9]{0,3}$/.test(norm);
  }

  function median(arr) {
    if (!arr.length) return NaN;
    const a = arr.slice().sort((x, y) => x - y);
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  // PDF の行ベクトル規約 [a b c d e f]: p' = p・M
  const MAT = {
    id() {
      return [1, 0, 0, 1, 0, 0];
    },
    translate(tx, ty) {
      return [1, 0, 0, 1, tx, ty];
    },
    mul(a, b) {
      // a を先に適用してから b（p・a・b）
      return [
        a[0] * b[0] + a[1] * b[2],
        a[0] * b[1] + a[1] * b[3],
        a[2] * b[0] + a[3] * b[2],
        a[2] * b[1] + a[3] * b[3],
        a[4] * b[0] + a[5] * b[2] + b[4],
        a[4] * b[1] + a[5] * b[3] + b[5],
      ];
    },
    apply(m, x, y) {
      return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    },
    // 等方近似の拡大率（線幅・文字サイズのデバイス換算に使う）
    scaleOf(m) {
      const det = Math.abs(m[0] * m[3] - m[1] * m[2]);
      return det > 0 ? Math.sqrt(det) : Math.hypot(m[0], m[1]);
    },
  };

  function latin1(bytes, start, end) {
    start = start || 0;
    if (end === undefined) end = bytes.length;
    let s = "";
    const CHUNK = 8192;
    for (let i = start; i < end; i += CHUNK) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(end, i + CHUNK)));
    }
    return s;
  }

  // バイト列から ASCII 文字列を探す（見つからなければ -1）
  function indexOfBytes(hay, needleStr, from) {
    const n = needleStr.length;
    const first = needleStr.charCodeAt(0);
    outer: for (let i = Math.max(0, from | 0); i <= hay.length - n; i++) {
      if (hay[i] !== first) continue;
      for (let j = 1; j < n; j++) {
        if (hay[i + j] !== needleStr.charCodeAt(j)) continue outer;
      }
      return i;
    }
    return -1;
  }

  function fmtMm(v, digits) {
    if (v == null || !isFinite(v)) return "—";
    const d = digits === undefined ? 1 : digits;
    const k = 10 ** d;
    const r = Math.round(v * k) / k;
    return (Object.is(r, -0) ? 0 : r).toFixed(d); // "-0.0" を出さない
  }

  ZC.util = { normalizeLabel, parseDimNumber, isAxisLabel, median, MAT, latin1, indexOfBytes, fmtMm };
})(globalThis.ZC = globalThis.ZC || {});
