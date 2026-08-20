// 寸法注記の読み取り: 「黒いドット間にある直線の上の数字」を寸法値として拾う。
// 寸法線は通り芯間で分割記載されることがあるため、芯々の値はチェーンの合計で求める。
(function (ZC) {
  "use strict";

  const U = ZC.util;

  const PARAMS = {
    DOT_MERGE: 0.6,       // 重複ドットの統合距離(pt)
    ROW_TOL: 0.7,         // 同一寸法線とみなすドット位置の揃い(pt)
    LINE_TOL: 0.8,        // ドット間の直線を探すときの線位置の許容(pt)
    LINE_COVER_TOL: 1.6,  // 直線がドット間を覆っているかの端の許容(pt)
    MIN_SPAN: 2.5,        // ドット間隔の最小(pt)
    TEXT_NEAR_MIN: 0.15,  // 数字は線から少し浮いている（最小 pt）
    TEXT_NEAR_MAX: 2.2,   // 数字と線の距離の最大（文字サイズ×この値）
    TEXT_CENTER: 0.48,    // 数字の中心はスパン中央からこの比率以内
    AXIS_SNAP: 1.6,       // ドットと通り芯位置の一致判定(pt)
    CHAIN_TOL: 1.2,       // 分割寸法の連続性の許容(pt)
    CONFLICT_MM: 0.6,     // 寸法段どうしの食い違い検出(mm)
    MERGE_GAP: 0.9,       // 数字ランの結合: 文字サイズ×この値までの隙間
    SCALE_MIN_GAP: 8,     // 縮尺推定に使うスパンの最小(pt)
    SCALE_MIN_VALUE: 100, // 縮尺推定に使う寸法値の最小(mm)
  };

  // 近接する数字ラン（"3" "000" など）を同一ベースラインで結合する
  function mergeTexts(texts) {
    const runs = texts.map((t) => {
      const ex = t.ex !== undefined ? t.ex : t.x;
      const ey = t.ey !== undefined ? t.ey : t.y;
      return {
        str: t.str,
        x: t.x,
        y: t.y,
        ex,
        ey,
        size: t.size || 10,
        horizontal: Math.abs(ex - t.x) >= Math.abs(ey - t.y),
      };
    });
    const out = [];
    for (const horiz of [true, false]) {
      const list = runs.filter((r) => r.horizontal === horiz);
      if (horiz) list.sort((a, b) => (Math.abs(a.y - b.y) > 0.6 ? a.y - b.y : a.x - b.x));
      else list.sort((a, b) => (Math.abs(a.x - b.x) > 0.6 ? a.x - b.x : a.y - b.y));
      let cur = null;
      for (const r of list) {
        if (cur) {
          const sameLine = horiz ? Math.abs(r.y - cur.y) <= 0.6 : Math.abs(r.x - cur.x) <= 0.6;
          const gap = horiz ? r.x - cur.ex : r.y - cur.ey;
          if (sameLine && gap >= -0.6 && gap <= cur.size * PARAMS.MERGE_GAP) {
            cur.str += r.str;
            cur.ex = r.ex;
            cur.ey = r.ey;
            continue;
          }
        }
        cur = { str: r.str, x: r.x, y: r.y, ex: r.ex, ey: r.ey, size: r.size, horizontal: r.horizontal };
        out.push(cur);
      }
    }
    return out;
  }

  function clusterDots(dots) {
    const sorted = dots.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    const out = [];
    for (const d of sorted) {
      const prev = out.find(
        (o) => Math.abs(o.x - d.x) <= PARAMS.DOT_MERGE && Math.abs(o.y - d.y) <= PARAMS.DOT_MERGE
      );
      if (!prev) out.push({ x: d.x, y: d.y });
    }
    return out;
  }

  // dir="v": 横向きの寸法線（縦芯の間隔を測る） / dir="h": 縦向きの寸法線
  function buildEntries(dir, dots, texts, segments, entries) {
    const along = dir === "v" ? (p) => p.x : (p) => p.y; // 測る方向の座標
    const cross = dir === "v" ? (p) => p.y : (p) => p.x; // 寸法線の位置

    // 寸法線になり得る直線（測る方向に伸びる線）を前抽出
    const lines = [];
    for (const s of segments) {
      if (s.curve) continue;
      const c1 = dir === "v" ? s.y1 : s.x1;
      const c2 = dir === "v" ? s.y2 : s.x2;
      if (Math.abs(c1 - c2) > 0.3) continue;
      const a1 = dir === "v" ? s.x1 : s.y1;
      const a2 = dir === "v" ? s.x2 : s.y2;
      lines.push({ c: (c1 + c2) / 2, a: Math.min(a1, a2), b: Math.max(a1, a2) });
    }

    // ドットを寸法線の位置（cross座標）でグループ化して「段」を作る
    const sorted = dots.slice().sort((p, q) => cross(p) - cross(q));
    const rows = [];
    let row = null;
    for (const d of sorted) {
      if (row && cross(d) - row.c <= PARAMS.ROW_TOL) {
        row.items.push(d);
        row.c = (row.c * (row.items.length - 1) + cross(d)) / row.items.length;
      } else {
        row = { c: cross(d), items: [d] };
        rows.push(row);
      }
    }

    const usedTexts = new Set();
    for (const r of rows) {
      if (r.items.length < 2) continue;
      const pts = r.items.map(along).sort((a, b) => a - b);
      const rowLines = lines.filter((l) => Math.abs(l.c - r.c) <= PARAMS.LINE_TOL);
      if (!rowLines.length) continue;
      for (let i = 0; i + 1 < pts.length; i++) {
        const p1 = pts[i];
        const p2 = pts[i + 1];
        if (p2 - p1 < PARAMS.MIN_SPAN) continue;
        // ドット間に直線があること
        const covered = rowLines.some(
          (l) => l.a <= p1 + PARAMS.LINE_COVER_TOL && l.b >= p2 - PARAMS.LINE_COVER_TOL
        );
        if (!covered) continue;
        // 線の上（横段なら上側 / 縦段なら左側優先）にある数字を探す
        let best = null;
        let bestScore = Infinity;
        const mid = (p1 + p2) / 2;
        for (let ti = 0; ti < texts.length; ti++) {
          if (usedTexts.has(ti)) continue;
          const t = texts[ti];
          if (dir === "v" ? !t.horizontal : t.horizontal) continue;
          const value = U.parseDimNumber(t.str);
          if (value == null) continue;
          const tm = dir === "v" ? (t.x + t.ex) / 2 : (t.y + t.ey) / 2;
          const tc = dir === "v" ? (t.y + t.ey) / 2 : (t.x + t.ex) / 2;
          const off = dir === "v" ? tc - r.c : r.c - tc; // 上側/左側が正
          const lift = Math.abs(off);
          if (lift < PARAMS.TEXT_NEAR_MIN || lift > t.size * PARAMS.TEXT_NEAR_MAX) continue;
          if (Math.abs(tm - mid) > (p2 - p1) * PARAMS.TEXT_CENTER) continue;
          const score = Math.abs(tm - mid) + lift * 0.5 + (off < 0 ? 8 : 0); // 反対側は減点
          if (score < bestScore) {
            bestScore = score;
            best = { ti, value };
          }
        }
        if (best) {
          usedTexts.add(best.ti);
          entries.push({ dir, row: r.c, p1, p2, value: best.value });
        }
      }
    }
  }

  // 抽出結果から寸法注記エントリを組み立てる
  function extract(ex) {
    const dots = clusterDots(ex.dots || []);
    const entries = [];
    if (dots.length >= 2) {
      const texts = mergeTexts(ex.texts || []);
      buildEntries("v", dots, texts, ex.segments || [], entries);
      buildEntries("h", dots, texts, ex.segments || [], entries);
    }
    return { dots, entries };
  }

  // 2つの通り芯位置の間の「記載寸法」を求める。分割記載はチェーンの合計。
  // 複数の寸法段が該当する場合は分割数の少ない段を採用し、食い違いは conflict で知らせる。
  function spanValue(entries, dir, posA, posB) {
    const lo = Math.min(posA, posB);
    const hi = Math.max(posA, posB);
    const AX = PARAMS.AXIS_SNAP;
    const byRow = new Map();
    for (const e of entries) {
      if (e.dir !== dir) continue;
      if (e.p1 < lo - AX || e.p2 > hi + AX) continue;
      const key = Math.round(e.row * 4);
      if (!byRow.has(key)) byRow.set(key, []);
      byRow.get(key).push(e);
    }
    const candidates = [];
    for (const list of byRow.values()) {
      list.sort((a, b) => a.p1 - b.p1);
      if (Math.abs(list[0].p1 - lo) > AX) continue;
      if (Math.abs(list[list.length - 1].p2 - hi) > AX) continue;
      let ok = true;
      let sum = 0;
      const parts = [];
      for (let i = 0; i < list.length; i++) {
        if (i > 0 && Math.abs(list[i].p1 - list[i - 1].p2) > PARAMS.CHAIN_TOL) {
          ok = false;
          break;
        }
        sum += list[i].value;
        parts.push(list[i].value);
      }
      if (ok) candidates.push({ sum, parts });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => a.parts.length - b.parts.length);
    const best = candidates[0];
    const conflict = candidates.some((c) => Math.abs(c.sum - best.sum) > PARAMS.CONFLICT_MM);
    return { value: best.sum, parts: best.parts, conflict };
  }

  // 縮尺推定用サンプル: 各エントリの 記載値 ÷ ドット間隔
  function scaleSamples(entries) {
    const out = [];
    for (const e of entries) {
      const gap = e.p2 - e.p1;
      if (gap < PARAMS.SCALE_MIN_GAP || e.value < PARAMS.SCALE_MIN_VALUE) continue;
      out.push({ dir: e.dir, gapPt: gap, value: e.value, mmPerPt: e.value / gap });
    }
    return out;
  }

  ZC.dims = { extract, spanValue, scaleSamples, mergeTexts, PARAMS };
})(globalThis.ZC = globalThis.ZC || {});
