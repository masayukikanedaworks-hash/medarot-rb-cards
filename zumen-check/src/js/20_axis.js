// 通り芯検出: 軸平行の線分を束ねて長い「芯」を推定し、符号ラベルを対応付ける
(function (ZC) {
  "use strict";

  const U = ZC.util;

  // 調整パラメータ（単位は pt = 1/72 インチ）。詳細は CLAUDE.md 参照
  const PARAMS = {
    ANGLE_TOL: 0.002,      // 軸平行判定: 短辺のずれ ≤ max(0.3pt, 長さ×この値)
    MIN_PIECE_LEN: 0.4,    // 候補に含める線分の最小長
    CLUSTER_TOL: 0.35,     // 同一の芯とみなす位置ずれ
    GAP_TOL: 14,           // 鎖線・破線の切れ目を連結する最大間隔
    MIN_LEN_RATIO: 0.28,   // 内容範囲に対する最小長さ比
    MIN_LEN_ABS: 80,       // 最小長さの絶対値
    FRAME_EDGE_TOL: 3,     // 内容範囲の端からこの距離以内なら図枠の疑い
    LABEL_RADIUS: 40,      // 端点から符号ラベルを探す半径
    LABEL_LATERAL: 30,     // 芯の位置とラベルの横ずれの許容
    CHAIN_MIN_PIECES: 4,   // 分割描画の鎖線とみなす最小の線分本数
    CHAIN_COVER_MIN: 0.2,  // 〃 カバー率の下限
    CHAIN_COVER_MAX: 0.96, // 〃 カバー率の上限
  };

  // extract: ContentExtractor.run() の結果
  function detect(extract) {
    const segs = extract.segments;
    if (!segs.length) return { v: [], h: [], bbox: null };

    // 内容範囲（全線分のバウンディングボックス）
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const s of segs) {
      bx0 = Math.min(bx0, s.x1, s.x2);
      bx1 = Math.max(bx1, s.x1, s.x2);
      by0 = Math.min(by0, s.y1, s.y2);
      by1 = Math.max(by1, s.y1, s.y2);
    }
    const bbox = { x0: bx0, y0: by0, x1: bx1, y1: by1 };

    // 軸平行線分の収集
    const vPieces = []; // 縦線: pos=x
    const hPieces = []; // 横線: pos=y
    for (const s of segs) {
      if (s.curve) continue;
      const dx = Math.abs(s.x1 - s.x2);
      const dy = Math.abs(s.y1 - s.y2);
      if (dy >= dx) {
        const len = dy;
        if (len < PARAMS.MIN_PIECE_LEN) continue;
        if (dx <= Math.max(0.3, len * PARAMS.ANGLE_TOL)) {
          vPieces.push({
            pos: (s.x1 + s.x2) / 2,
            a: Math.min(s.y1, s.y2),
            b: Math.max(s.y1, s.y2),
            len,
            dashed: s.dashed,
          });
        }
      } else {
        const len = dx;
        if (len < PARAMS.MIN_PIECE_LEN) continue;
        if (dy <= Math.max(0.3, len * PARAMS.ANGLE_TOL)) {
          hPieces.push({
            pos: (s.y1 + s.y2) / 2,
            a: Math.min(s.x1, s.x2),
            b: Math.max(s.x1, s.x2),
            len,
            dashed: s.dashed,
          });
        }
      }
    }

    const vAxes = buildAxes(vPieces, "v", by1 - by0, bx0, bx1);
    const hAxes = buildAxes(hPieces, "h", bx1 - bx0, by0, by1);

    // 符号ラベルの対応付け（縦横まとめて貪欲法で最短距離から割り当て）
    assignLabels(vAxes.concat(hAxes), extract.texts);

    for (const list of [vAxes, hAxes]) {
      list.sort((p, q) => p.pos - q.pos);
      list.forEach((ax, i) => {
        ax.index = i;
        ax.defaultOn = !ax.frameSuspect && (ax.label != null || ax.dashed);
      });
    }
    return { v: vAxes, h: hAxes, bbox };
  }

  // 同方向の線分群から芯候補を組み立てる
  function buildAxes(pieces, dir, extentRef, edge0, edge1) {
    if (!pieces.length) return [];
    pieces.sort((p, q) => p.pos - q.pos);
    const clusters = [];
    let cl = null;
    for (const p of pieces) {
      if (cl && p.pos - cl.mean <= PARAMS.CLUSTER_TOL) {
        cl.items.push(p);
        cl.wsum += p.pos * p.len;
        cl.lsum += p.len;
        cl.mean = cl.wsum / Math.max(cl.lsum, 1e-9);
      } else {
        cl = { items: [p], wsum: p.pos * p.len, lsum: p.len, mean: p.pos };
        clusters.push(cl);
      }
    }

    const minLen = Math.max(PARAMS.MIN_LEN_ABS, PARAMS.MIN_LEN_RATIO * extentRef);
    const axes = [];
    for (const c of clusters) {
      // 位置方向に区間をつなぎ、最長の連結チェーンを採用
      const iv = c.items.slice().sort((p, q) => p.a - q.a);
      let best = null;
      let chain = null;
      for (const p of iv) {
        if (chain && p.a - chain.to <= PARAMS.GAP_TOL) {
          chain.to = Math.max(chain.to, p.b);
          chain.cover += p.len;
          chain.pieces++;
          chain.dashedLen += p.dashed ? p.len : 0;
        } else {
          chain = { from: p.a, to: p.b, cover: p.len, pieces: 1, dashedLen: p.dashed ? p.len : 0 };
          if (!best || chain.to - chain.from > best.to - best.from) best = chain;
        }
        if (chain.to - chain.from > best.to - best.from) best = chain;
      }
      if (!best) continue;
      const extent = best.to - best.from;
      if (extent < minLen) continue;
      const cover = Math.min(1, best.cover / Math.max(extent, 1e-9));
      const dashedFrac = best.dashedLen / Math.max(best.cover, 1e-9);
      const chainLike =
        best.pieces >= PARAMS.CHAIN_MIN_PIECES &&
        cover >= PARAMS.CHAIN_COVER_MIN &&
        cover <= PARAMS.CHAIN_COVER_MAX;
      const pos = c.mean;
      axes.push({
        dir,
        pos,
        from: best.from,
        to: best.to,
        extent,
        cover,
        pieces: best.pieces,
        dashed: dashedFrac > 0.3 || chainLike,
        frameSuspect:
          Math.abs(pos - edge0) <= PARAMS.FRAME_EDGE_TOL ||
          Math.abs(pos - edge1) <= PARAMS.FRAME_EDGE_TOL,
        label: null,
        labelXY: null,
      });
    }
    return axes;
  }

  function assignLabels(axes, texts) {
    const cands = [];
    for (const t of texts) {
      const norm = U.normalizeLabel(t.str);
      if (!U.isAxisLabel(norm)) continue;
      cands.push({
        norm,
        x: (t.x + (t.ex !== undefined ? t.ex : t.x)) / 2,
        y: (t.y + (t.ey !== undefined ? t.ey : t.y)) / 2,
        size: t.size || 10,
        used: false,
      });
    }
    if (!cands.length) return;
    const pairs = [];
    for (const ax of axes) {
      const ends =
        ax.dir === "v"
          ? [
              [ax.pos, ax.from],
              [ax.pos, ax.to],
            ]
          : [
              [ax.from, ax.pos],
              [ax.to, ax.pos],
            ];
      for (const t of cands) {
        const lateral = ax.dir === "v" ? Math.abs(t.x - ax.pos) : Math.abs(t.y - ax.pos);
        if (lateral > PARAMS.LABEL_LATERAL) continue;
        for (const [ex, ey] of ends) {
          const d = Math.hypot(t.x - ex, t.y - ey);
          if (d <= PARAMS.LABEL_RADIUS + t.size) pairs.push({ ax, t, d });
        }
      }
    }
    pairs.sort((p, q) => p.d - q.d);
    for (const p of pairs) {
      if (p.ax.label != null || p.t.used) continue;
      p.ax.label = p.t.norm;
      p.ax.labelXY = { x: p.t.x, y: p.t.y };
      p.t.used = true;
    }
  }

  // 表示名（符号が無い芯は方向+連番）
  function displayName(ax) {
    if (ax.label != null) return ax.label;
    return (ax.dir === "v" ? "縦" : "横") + (ax.index + 1);
  }

  ZC.axis = { detect, displayName, PARAMS };
})(globalThis.ZC = globalThis.ZC || {});
