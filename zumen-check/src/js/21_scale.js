// 縮尺推定: 隣り合う通り芯の間に書かれた寸法値から mm/pt を求める
(function (ZC) {
  "use strict";

  const U = ZC.util;
  const PT_PER_MM = 72 / 25.4;

  // よく使われる縮尺の分母
  const STD_SCALES = [10, 20, 25, 30, 40, 50, 60, 75, 100, 120, 125, 150, 200, 250, 300, 400, 500, 600, 1000, 1200];

  const PARAMS = {
    MIN_GAP: 8,        // 寸法探索の対象にする最小の芯間隔(pt)
    MID_RATIO: 0.35,   // 寸法値は区間中央からこの比率以内にあること
    PERP_MARGIN: 80,   // 芯の長さ方向の探索マージン(pt)
    CLUSTER_REL: 0.025 // 同一縮尺とみなす mm/pt の相対差
  };

  // 有効な芯リストと全テキストから「芯ペアに対応する寸法値」を集める
  // 戻り値: [{dir, i, aName, bName, value, gapPt, mmPerPt, dist}]
  function collectDimSamples(vAxes, hAxes, texts) {
    const dims = [];
    for (const t of texts) {
      const value = U.parseDimNumber(t.str);
      if (value == null) continue;
      dims.push({
        value,
        x: (t.x + (t.ex !== undefined ? t.ex : t.x)) / 2,
        y: (t.y + (t.ey !== undefined ? t.ey : t.y)) / 2,
      });
    }
    if (!dims.length) return [];
    const samples = [];
    for (const [dir, axes] of [["v", vAxes], ["h", hAxes]]) {
      const sorted = axes.slice().sort((p, q) => p.pos - q.pos);
      for (let i = 0; i + 1 < sorted.length; i++) {
        const a = sorted[i];
        const b = sorted[i + 1];
        const gap = b.pos - a.pos;
        if (gap < PARAMS.MIN_GAP) continue;
        const mid = (a.pos + b.pos) / 2;
        const perpLo = Math.min(a.from, b.from) - PARAMS.PERP_MARGIN;
        const perpHi = Math.max(a.to, b.to) + PARAMS.PERP_MARGIN;
        let bestDim = null;
        let bestDist = Infinity;
        for (const d of dims) {
          const along = dir === "v" ? d.x : d.y;
          const perp = dir === "v" ? d.y : d.x;
          if (perp < perpLo || perp > perpHi) continue;
          const off = Math.abs(along - mid);
          if (off > gap * PARAMS.MID_RATIO) continue;
          if (off < bestDist) {
            bestDist = off;
            bestDim = d;
          }
        }
        if (bestDim) {
          samples.push({
            dir,
            i,
            a,
            b,
            value: bestDim.value,
            gapPt: gap,
            mmPerPt: bestDim.value / gap,
            dist: bestDist,
          });
        }
      }
    }
    return samples;
  }

  // サンプル群から縮尺を推定する
  // 戻り値: {den, mmPerPt, snapped, count} または den=null（推定不能）
  function infer(samples) {
    if (!samples.length) return { den: null, mmPerPt: null, snapped: false, count: 0 };
    const vals = samples.map((s) => s.mmPerPt).sort((a, b) => a - b);
    // 相対差 CLUSTER_REL 以内に収まる最大の窓を探す
    let bestLo = 0;
    let bestN = 1;
    for (let lo = 0, hi = 0; lo < vals.length; lo++) {
      if (hi < lo) hi = lo;
      while (hi + 1 < vals.length && vals[hi + 1] <= vals[lo] * (1 + PARAMS.CLUSTER_REL)) hi++;
      if (hi - lo + 1 > bestN) {
        bestN = hi - lo + 1;
        bestLo = lo;
      }
    }
    const win = vals.slice(bestLo, bestLo + bestN);
    let mmPerPt = U.median(win);
    let den = mmPerPt * PT_PER_MM;
    let snapped = false;
    for (const s of STD_SCALES) {
      if (Math.abs(den / s - 1) <= 0.02) {
        den = s;
        mmPerPt = s / PT_PER_MM;
        snapped = true;
        break;
      }
    }
    return { den, mmPerPt, snapped, count: bestN };
  }

  function mmPerPtFromDen(den) {
    return den / PT_PER_MM;
  }

  ZC.scale = { collectDimSamples, infer, mmPerPtFromDen, PT_PER_MM, PARAMS, STD_SCALES };
})(globalThis.ZC = globalThis.ZC || {});
