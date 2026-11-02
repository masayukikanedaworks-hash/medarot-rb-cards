// 線で描かれた文字の読み取り。
// CAD のシングルストローク（SHX）フォントのまま PDF 化された図面は、数字も符号も
// 文字ではなく線分の集まりになる（PDF に文字データが残らない）。ここではその
// ストロークを文字単位にまとめ、同じ形＝同じ文字として集約し、形と文字の
// 対応表（利用者が一度だけ教える）を使って文字列に起こす。
//
// 対応表はフォントごとに違うので、図面から集めた形の一覧（fingerprint）を鍵にして
// 保存する。別のCADの図面を読んだときは別の対応表になる。
(function (ZC) {
  "use strict";

  const PARAMS = {
    MAX_STROKE: 9, // 文字のストロークとみなす線分の最大長(pt)
    JOIN_DIST: 0.4, // 同じ文字のストロークとみなす距離(pt)
    MIN_H: 1.2, // 行の起点になれる文字の最小高さ(pt)
    MIN_SMALL_H: 0.2, // 行に加われる小さな字形の最小高さ(pt)。小数点など
    SMALL_RATIO: 0.45, // 行の文字高さに対して「小さな字形」とみなす比
    MAX_H: 14, // 文字の最大高さ(pt)
    MAX_WH: 1.5, // 1文字らしさ: 幅/高さ（横書き）の上限
    RUN_GAP: 0.9, // 同じ文字列とみなす字間（文字高さ比）
    BASE_TOL: 0.3, // 同じ文字列とみなすベースラインのずれ（文字高さ比）
    H_TOL: 0.3, // 同じ文字列とみなす高さの差（比）
    QUANT: 0.05, // 形の正規化の丸め（高さ=1に正規化した座標）
    MIN_SHAPE_COUNT: 1, // 一覧に出す形の最小出現回数
  };

  const q = (v) => Math.round(v / PARAMS.QUANT) * PARAMS.QUANT;
  const r2 = (v) => (Math.abs(v) < 1e-9 ? 0 : Math.round(v * 100) / 100);

  function segBox(s) {
    return {
      x0: Math.min(s.x1, s.x2),
      y0: Math.min(s.y1, s.y2),
      x1: Math.max(s.x1, s.x2),
      y1: Math.max(s.y1, s.y2),
    };
  }

  function union(a, b) {
    return {
      x0: Math.min(a.x0, b.x0),
      y0: Math.min(a.y0, b.y0),
      x1: Math.max(a.x1, b.x1),
      y1: Math.max(a.y1, b.y1),
    };
  }

  // 線分と点の距離
  function distPointSeg(px, py, s) {
    const dx = s.x2 - s.x1;
    const dy = s.y2 - s.y1;
    const L = dx * dx + dy * dy;
    let t = L > 0 ? ((px - s.x1) * dx + (py - s.y1) * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (s.x1 + t * dx), py - (s.y1 + t * dy));
  }

  // 線分どうしの近さ（端点と中点で見る簡易版。文字のストロークは短いので十分）
  function segNear(a, b) {
    const pts = [
      [a.x1, a.y1],
      [a.x2, a.y2],
      [(a.x1 + a.x2) / 2, (a.y1 + a.y2) / 2],
    ];
    let d = Infinity;
    for (const [px, py] of pts) d = Math.min(d, distPointSeg(px, py, b));
    for (const [px, py] of [
      [b.x1, b.y1],
      [b.x2, b.y2],
    ]) {
      d = Math.min(d, distPointSeg(px, py, a));
    }
    return d;
  }

  // 短い線分を「1文字分」にまとめる。CAD は 1 文字のストロークを続けて出力するので、
  // 出現順を保ったまま、近いストロークだけを連ねる。
  function groupGlyphs(segments) {
    const out = [];
    let cur = null;
    const closeCur = () => {
      if (cur) out.push(cur);
      cur = null;
    };
    for (const s of segments || []) {
      if (s.curve) {
        closeCur();
        continue;
      }
      const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
      if (len > PARAMS.MAX_STROKE || len <= 0) {
        closeCur();
        continue;
      }
      const b = segBox(s);
      if (cur) {
        const nb = union(cur.box, b);
        const h = nb.y1 - nb.y0;
        const w = nb.x1 - nb.x0;
        const fits = h <= PARAMS.MAX_H && w <= PARAMS.MAX_H * PARAMS.MAX_WH;
        if (fits && cur.segs.some((o) => segNear(o, s) <= PARAMS.JOIN_DIST)) {
          cur.segs.push(s);
          cur.box = nb;
          continue;
        }
      }
      closeCur();
      cur = { segs: [s], box: b };
    }
    closeCur();
    return out
      .map((g) => {
        const w = g.box.x1 - g.box.x0;
        const h = g.box.y1 - g.box.y0;
        return { segs: g.segs, x0: g.box.x0, y0: g.box.y0, x1: g.box.x1, y1: g.box.y1, w, h };
      })
      .filter((g) => {
        const big = Math.max(g.w, g.h);
        const small = Math.min(g.w, g.h);
        if (big < PARAMS.MIN_SMALL_H || big > PARAMS.MAX_H) return false;
        // 1文字らしい縦横比（細長すぎる線の束は文字ではない）
        if (small > big * PARAMS.MAX_WH) return false;
        g.seed = big >= PARAMS.MIN_H; // 行の起点になれる大きさか
        return true;
      });
  }

  // 形の指紋。高さ(横書き)または幅(縦書き)を1に正規化してから丸める。
  // 同じ文字・同じフォントなら必ず同じ値になる。
  function shapeOf(glyph) {
    const base = Math.max(glyph.w, glyph.h) || 1;
    const parts = glyph.segs.map((s) => {
      const a = [q((s.x1 - glyph.x0) / base), q((s.y1 - glyph.y0) / base)];
      const b = [q((s.x2 - glyph.x0) / base), q((s.y2 - glyph.y0) / base)];
      // 線分の向きは文字の形に関係ないので、端点を並べ替えて同じ表現にする
      const [p, r] = a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]) ? [a, b] : [b, a];
      return r2(p[0]) + "," + r2(p[1]) + "," + r2(r[0]) + "," + r2(r[1]);
    });
    parts.sort();
    return parts.join("|");
  }

  // 字形を90度単位で回す（縦書きの寸法注記は90度回転で描かれるため）。
  // turns: 1 = 反時計回り90度 / 3 = 時計回り90度。180度は使わない
  // （6 と 9 が入れ替わるフォントがあり、区別できなくなるため）。
  function rotateGlyph(glyph, turns) {
    const t = ((turns % 4) + 4) % 4;
    if (t === 0) return glyph;
    const segs = glyph.segs.map((s) => {
      const p = [];
      for (const [x, y] of [
        [s.x1, s.y1],
        [s.x2, s.y2],
      ]) {
        const u = x - glyph.x0;
        const v = y - glyph.y0;
        if (t === 1) p.push([-v, u]);
        else if (t === 2) p.push([-u, -v]);
        else p.push([v, -u]);
      }
      return { x1: p[0][0], y1: p[0][1], x2: p[1][0], y2: p[1][1] };
    });
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const s of segs) {
      x0 = Math.min(x0, s.x1, s.x2);
      x1 = Math.max(x1, s.x1, s.x2);
      y0 = Math.min(y0, s.y1, s.y2);
      y1 = Math.max(y1, s.y1, s.y2);
    }
    return { segs, x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
  }

  // この字形を ±90 度回したときの指紋。縦書きの同じ文字を横書きと結び付ける
  // ヒントに使う（自動では決めず、画面で確認・修正できるようにする）。
  function rotations(glyph) {
    return [shapeOf(rotateGlyph(glyph, 1)), shapeOf(rotateGlyph(glyph, 3))];
  }

  // 文字を行（文字列）にまとめる。横書きと縦書きを分けて扱う。
  function buildRuns(glyphs) {
    const runs = [];
    for (const horizontal of [true, false]) {
      // 小数点のような小さな字形は向きが判定できないので、どちらの向きでも候補にする
      const list = glyphs.filter((g) => !g.seed || (g.h >= g.w) === horizontal);
      const seeds = list.filter((g) => g.seed && (g.h >= g.w) === horizontal);
      if (!seeds.length) continue;
      const along = horizontal ? (g) => g.x0 : (g) => g.y0;
      const alongEnd = horizontal ? (g) => g.x1 : (g) => g.y1;
      const cross = horizontal ? (g) => g.y0 : (g) => g.x0;
      const size = (g) => (horizontal ? g.h : g.w);
      seeds.sort((a, b) => cross(a) - cross(b) || along(a) - along(b));
      const used = new Set();
      for (const g of seeds) {
        if (used.has(g)) continue;
        const run = { horizontal, glyphs: [g] };
        used.add(g);
        let last = g;
        const H = size(g); // 行の文字高さ（起点の文字で決める）
        // 同じ行で右（縦書きなら上）に続く文字を順に拾う
        for (;;) {
          let best = null;
          let bestD = Infinity;
          for (const c of list) {
            if (used.has(c)) continue;
            const small = size(c) <= H * PARAMS.SMALL_RATIO;
            // 小数点などの小さな字形は高さを問わず、ベースラインが合っていれば拾う
            if (!small && Math.abs(size(c) - H) > H * PARAMS.H_TOL) continue;
            if (Math.abs(cross(c) - cross(last)) > H * PARAMS.BASE_TOL) continue;
            const gap = along(c) - alongEnd(last);
            if (gap < -H * 0.2 || gap > H * PARAMS.RUN_GAP) continue;
            if (gap < bestD) {
              bestD = gap;
              best = c;
            }
          }
          if (!best) break;
          run.glyphs.push(best);
          used.add(best);
          last = best;
        }
        runs.push(run);
      }
    }
    for (const run of runs) {
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (const g of run.glyphs) {
        x0 = Math.min(x0, g.x0);
        y0 = Math.min(y0, g.y0);
        x1 = Math.max(x1, g.x1);
        y1 = Math.max(y1, g.y1);
      }
      run.x0 = x0;
      run.y0 = y0;
      run.x1 = x1;
      run.y1 = y1;
      run.size = (run.horizontal ? y1 - y0 : x1 - x0) / 0.7; // 字高からフォントサイズ相当へ
    }
    return runs;
  }

  // 図面から「線で描かれた文字」を取り出す。
  // 返り値の shapes は {shape, count, glyph, rot} の配列（出現回数の多い順）。
  function extract(ex) {
    const glyphs = groupGlyphs((ex && ex.segments) || []);
    for (const g of glyphs) g.shape = shapeOf(g);
    const runs = buildRuns(glyphs);
    const inRuns = [];
    for (const r of runs) for (const g of r.glyphs) inRuns.push(g);
    const byShape = new Map();
    for (const g of inRuns) {
      const e = byShape.get(g.shape);
      if (e) e.count++;
      else byShape.set(g.shape, { shape: g.shape, count: 1, glyph: g, rot: rotations(g) });
    }
    const shapes = [...byShape.values()]
      .filter((s) => s.count >= PARAMS.MIN_SHAPE_COUNT)
      .sort((a, b) => b.count - a.count || (a.shape < b.shape ? -1 : 1));
    return { glyphs, runs, shapes };
  }

  // 形→文字の対応表で、行を文字列にする。
  // 1文字でも対応が無い行は捨てる（半端な数字を読むほうが危ないため）。
  function toTexts(runs, map) {
    const out = [];
    if (!map) return out;
    for (const run of runs) {
      let str = "";
      let ok = true;
      for (const g of run.glyphs) {
        const ch = map[g.shape];
        if (ch == null || ch === "") {
          ok = false;
          break;
        }
        str += ch;
      }
      if (!ok || !str) continue;
      out.push(
        run.horizontal
          ? { str, x: run.x0, y: run.y0, ex: run.x1, ey: run.y0, size: run.size, glyphText: true }
          : { str, x: run.x0, y: run.y0, ex: run.x0, ey: run.y1, size: run.size, glyphText: true }
      );
    }
    return out;
  }

  // この図面のフォントを表す鍵。出現回数の多い形から作るので、同じCAD・同じ
  // フォントの図面なら同じ鍵になり、一度教えた対応表を使い回せる。
  function fingerprint(shapes) {
    const top = shapes.slice(0, 12).map((s) => s.shape);
    top.sort();
    let h = 0x811c9dc5;
    for (const ch of top.join("#")) {
      h ^= ch.codePointAt(0);
      h = (h * 0x01000193) >>> 0;
    }
    return "g" + h.toString(16) + "-" + shapes.length;
  }

  // 形を <svg> のパス文字列にする（対応表を入力してもらう画面のプレビュー用）
  function shapePath(glyph, size) {
    const s = size || 24;
    const base = Math.max(glyph.w, glyph.h) || 1;
    const sc = (s - 4) / base;
    const parts = [];
    for (const seg of glyph.segs) {
      const x1 = (seg.x1 - glyph.x0) * sc + 2;
      const y1 = s - 2 - (seg.y1 - glyph.y0) * sc;
      const x2 = (seg.x2 - glyph.x0) * sc + 2;
      const y2 = s - 2 - (seg.y2 - glyph.y0) * sc;
      parts.push(`M${r2(x1)} ${r2(y1)}L${r2(x2)} ${r2(y2)}`);
    }
    return parts.join("");
  }

  ZC.glyph = {
    extract,
    toTexts,
    fingerprint,
    shapePath,
    groupGlyphs,
    shapeOf,
    rotateGlyph,
    rotations,
    buildRuns,
    PARAMS,
  };
})((globalThis.ZC = globalThis.ZC || {}));
