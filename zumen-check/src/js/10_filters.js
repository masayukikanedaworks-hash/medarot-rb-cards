// PDF ストリームフィルタ（FlateDecode ほか）
// FlateDecode はブラウザ/Node 標準の DecompressionStream を使い、外部依存を持たない。
(function (ZC) {
  "use strict";

  function pump(format, bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
    return new Response(stream).arrayBuffer().then((b) => new Uint8Array(b));
  }

  function trimTrailingWs(bytes) {
    let end = bytes.length;
    while (end > 0 && [0, 9, 10, 12, 13, 32].includes(bytes[end - 1])) end--;
    return bytes.subarray(0, end);
  }

  async function inflate(bytes) {
    // zlib 形式 → 末尾ゴミ除去 → 生 deflate の順で試す（壊れ気味の PDF 対策）
    const attempts = [
      ["deflate", bytes],
      ["deflate", trimTrailingWs(bytes)],
      ["deflate-raw", bytes.length > 2 && (bytes[0] & 0x0f) === 8 ? bytes.subarray(2) : bytes],
    ];
    let lastErr = null;
    for (const [fmt, b] of attempts) {
      try {
        return await pump(fmt, b);
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error("FlateDecodeに失敗しました: " + (lastErr && lastErr.message));
  }

  // PNG/TIFF Predictor（主に xref ストリームで使われる）
  function applyPredictor(data, parms) {
    const pred = num(parms.Predictor, 1);
    if (pred <= 1) return data;
    const colors = num(parms.Colors, 1);
    const bpc = num(parms.BitsPerComponent, 8);
    const cols = num(parms.Columns, 1);
    const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
    const rowLen = Math.ceil((colors * bpc * cols) / 8);
    if (pred === 2) {
      // TIFF: bpc=8 のみ対応
      if (bpc !== 8) return data;
      const out = data.slice();
      for (let r = 0; r + rowLen <= out.length; r += rowLen) {
        for (let i = bpp; i < rowLen; i++) out[r + i] = (out[r + i] + out[r + i - bpp]) & 0xff;
      }
      return out;
    }
    // PNG系: 各行の先頭 1 バイトがフィルタ種別
    const rows = Math.floor(data.length / (rowLen + 1));
    const out = new Uint8Array(rows * rowLen);
    let prev = new Uint8Array(rowLen);
    for (let r = 0; r < rows; r++) {
      const ft = data[r * (rowLen + 1)];
      const src = data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1));
      const cur = out.subarray(r * rowLen, (r + 1) * rowLen);
      for (let i = 0; i < rowLen; i++) {
        const raw = src[i];
        const a = i >= bpp ? cur[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        let v;
        switch (ft) {
          case 0: v = raw; break;
          case 1: v = raw + a; break;
          case 2: v = raw + b; break;
          case 3: v = raw + ((a + b) >> 1); break;
          case 4: {
            const p = a + b - c;
            const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
            v = raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
            break;
          }
          default: v = raw;
        }
        cur[i] = v & 0xff;
      }
      prev = cur;
    }
    return out;
  }

  function asciiHexDecode(bytes) {
    const out = [];
    let hi = -1;
    for (let i = 0; i < bytes.length; i++) {
      const c = bytes[i];
      if (c === 0x3e) break; // >
      const d = hexVal(c);
      if (d < 0) continue;
      if (hi < 0) hi = d;
      else {
        out.push(hi * 16 + d);
        hi = -1;
      }
    }
    if (hi >= 0) out.push(hi * 16);
    return new Uint8Array(out);
  }

  function ascii85Decode(bytes) {
    const out = [];
    let tuple = 0, count = 0;
    let i = 0;
    // 先頭の <~ を読み飛ばす
    if (bytes[0] === 0x3c && bytes[1] === 0x7e) i = 2;
    for (; i < bytes.length; i++) {
      const c = bytes[i];
      if (c === 0x7e) break; // ~>
      if ([0, 9, 10, 12, 13, 32].includes(c)) continue;
      if (c === 0x7a && count === 0) { // z = 0x00000000
        out.push(0, 0, 0, 0);
        continue;
      }
      if (c < 0x21 || c > 0x75) continue;
      tuple = tuple * 85 + (c - 0x21);
      if (++count === 5) {
        out.push((tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff);
        tuple = 0;
        count = 0;
      }
    }
    if (count > 0) {
      for (let j = count; j < 5; j++) tuple = tuple * 85 + 84;
      const b = [(tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff];
      for (let j = 0; j < count - 1; j++) out.push(b[j]);
    }
    return new Uint8Array(out);
  }

  function runLengthDecode(bytes) {
    const out = [];
    let i = 0;
    while (i < bytes.length) {
      const l = bytes[i++];
      if (l === 128) break;
      if (l < 128) {
        for (let j = 0; j <= l; j++) out.push(bytes[i++]);
      } else {
        const b = bytes[i++];
        for (let j = 0; j < 257 - l; j++) out.push(b);
      }
    }
    return new Uint8Array(out);
  }

  async function decode(name, data, parms) {
    switch (name) {
      case "FlateDecode":
      case "Fl": {
        const inflated = await inflate(data);
        return applyPredictor(inflated, parms || {});
      }
      case "ASCIIHexDecode":
      case "AHx":
        return asciiHexDecode(data);
      case "ASCII85Decode":
      case "A85":
        return ascii85Decode(data);
      case "RunLengthDecode":
      case "RL":
        return runLengthDecode(data);
      case "DCTDecode":
      case "JPXDecode":
      case "CCITTFaxDecode":
      case "JBIG2Decode":
        // 画像系フィルタは対象外（線分抽出には不要）
        throw new Error("IMAGE_FILTER");
      default:
        throw new Error("未対応のフィルタです: " + name);
    }
  }

  function num(v, def) {
    return typeof v === "number" && isFinite(v) ? v : def;
  }

  function hexVal(c) {
    if (c >= 0x30 && c <= 0x39) return c - 0x30;
    if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
    if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
    return -1;
  }

  ZC.filters = { inflate, applyPredictor, asciiHexDecode, ascii85Decode, runLengthDecode, decode };
})(globalThis.ZC = globalThis.ZC || {});
