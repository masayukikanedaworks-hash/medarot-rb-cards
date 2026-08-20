// 通り芯検出: 軸平行の線分を束ねて長い「芯」を推定し、
// 「円（バブル）で囲まれた X○○ / Y○○」の符号だけを対応付ける。
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
    MIN_LEN_BUBBLE: 30,    // 符号バブルがある位置は部分的な短い芯でも採用する最小長さ
    FRAME_EDGE_TOL: 3,     // 内容範囲の端からこの距離以内なら図枠の疑い
    LABEL_LATERAL: 30,     // 芯の位置とバブル中心の横ずれの許容
    BUBBLE_REACH: 120,     // 芯の端点からバブル中心までの最大距離
    BUBBLE_TEXT_IN: 1.15,  // 文字がバブル内にあるとみなす半径倍率
    CHAIN_MIN_PIECES: 4,   // 分割描画の鎖線とみなす最小の線分本数
    CHAIN_COVER_MIN: 0.2,  // 〃 カバー率の下限
    CHAIN_COVER_MAX: 0.96, // 〃 カバー率の上限
  };

  const SIDES = ["top", "bottom", "left", "right"];
  const SIDE_NAME = { top: "上辺", bottom: "下辺", left: "左辺", right: "右辺" };

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

    // 符号（円で囲まれた X○○/Y○○）の候補を先に集める。
    // 部分的にしか引かれていない通り芯（X2.2 など）も、符号があれば採用するため。
    const cands = bubbleCandidates(extract.texts, extract.circles || []);
    const vAxes = buildAxes(vPieces, "v", by1 - by0, bx0, bx1, cands.filter((c) => c.dir === "v"));
    const hAxes = buildAxes(hPieces, "h", bx1 - bx0, by0, by1, cands.filter((c) => c.dir === "h"));

    assignLabels(vAxes.concat(hAxes), cands);

    for (const list of [vAxes, hAxes]) {
      list.sort((p, q) => p.pos - q.pos);
      list.forEach((ax, i) => {
        ax.index = i;
        // 照合対象は「円で囲まれた符号が付いた芯」のみ
        ax.defaultOn = !ax.frameSuspect && ax.label != null;
      });
    }
    return { v: vAxes, h: hAxes, bbox };
  }

  // 同方向の線分群から芯候補を組み立てる
  function buildAxes(pieces, dir, extentRef, edge0, edge1, cands) {
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
      const pos0 = c.mean;
      // 符号バブルが芯の延長線上にあるか（短い芯を救うための判定）
      const hasBubble = (cands || []).some((t) => {
        const lateral = dir === "v" ? Math.abs(t.x - pos0) : Math.abs(t.y - pos0);
        if (lateral > PARAMS.LABEL_LATERAL) return false;
        const along = dir === "v" ? t.y : t.x;
        return Math.max(best.from - along, along - best.to) <= PARAMS.BUBBLE_REACH;
      });
      if (extent < minLen && !(hasBubble && extent >= PARAMS.MIN_LEN_BUBBLE)) continue;
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
        bubbles: [], // {label, x, y, side}
      });
    }
    return axes;
  }

  // 円で囲まれた X○○/Y○○ の符号だけを候補として集める
  function bubbleCandidates(texts, circles) {
    const cands = [];
    if (!circles.length) return cands;
    for (const t of texts) {
      const lab = U.axisLabelOf(t.str);
      if (!lab) continue;
      const tx = (t.x + (t.ex !== undefined ? t.ex : t.x)) / 2;
      const ty = (t.y + (t.ey !== undefined ? t.ey : t.y)) / 2;
      let host = null;
      let hostD = Infinity;
      for (const c of circles) {
        const d = Math.hypot(tx - c.x, ty - c.y);
        if (d <= c.r * PARAMS.BUBBLE_TEXT_IN && d < hostD) {
          hostD = d;
          host = c;
        }
      }
      if (!host) continue; // 円で囲まれていない符号は拾わない
      cands.push({ norm: lab.label, dir: lab.dir, x: host.x, y: host.y, used: false });
    }
    return cands;
  }

  // 芯の上下（左右）両端に同じ符号が書かれるため、各芯は辺ごとにバブルを持つ。
  function assignLabels(axes, cands) {
    if (!cands.length) return;
    const pairs = [];
    for (const ax of axes) {
      for (const t of cands) {
        if (t.dir !== ax.dir) continue;
        const lateral = ax.dir === "v" ? Math.abs(t.x - ax.pos) : Math.abs(t.y - ax.pos);
        if (lateral > PARAMS.LABEL_LATERAL) continue;
        const along = ax.dir === "v" ? t.y : t.x;
        // 芯の延長線上（端点から BUBBLE_REACH 以内）にあること
        const dFrom = ax.from - along; // 正なら from より外側
        const dTo = along - ax.to; // 正なら to より外側
        const outside = Math.max(dFrom, dTo);
        if (outside > PARAMS.BUBBLE_REACH) continue;
        const side =
          ax.dir === "v"
            ? along >= (ax.from + ax.to) / 2 ? "top" : "bottom"
            : along >= (ax.from + ax.to) / 2 ? "right" : "left";
        pairs.push({ ax, t, side, score: lateral * 3 + Math.max(0, outside) });
      }
    }
    pairs.sort((p, q) => p.score - q.score);
    const usedSide = new Set(); // 「符号+辺」は1つの芯にのみ
    for (const p of pairs) {
      const key = p.t.norm + ":" + p.side;
      if (usedSide.has(key) || p.t.used) continue;
      if (p.ax.label != null && p.ax.label !== p.t.norm) continue; // 別符号は割り当てない
      if (p.ax.bubbles.some((b) => b.side === p.side)) continue;
      p.ax.label = p.t.norm;
      p.ax.labelXY = { x: p.t.x, y: p.t.y };
      p.ax.bubbles.push({ label: p.t.norm, x: p.t.x, y: p.t.y, side: p.side });
      usedSide.add(key);
      p.t.used = true;
    }
  }

  // 表示名（符号のみ。符号なしの芯は方向+連番）
  function displayName(ax) {
    if (ax.label != null) return ax.label;
    return (ax.dir === "v" ? "縦" : "横") + (ax.index + 1);
  }

  ZC.axis = { detect, displayName, bubbleCandidates, PARAMS, SIDES, SIDE_NAME };
})(globalThis.ZC = globalThis.ZC || {});
