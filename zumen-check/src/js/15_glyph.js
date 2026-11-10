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
    GRID: 16, // 形の指紋に使う格子の目数
    INK: 0.9, // 格子の中心からこの距離（セル何個分）以内なら塗る（太らせてずれに強くする）
    // 同じ文字とみなす指紋のずれ（塗りが違う格子の数）。
    // 実図面の同じ数字どうしは 0〜20、別の数字は 24 以上に分かれるが、
    // 1ストロークしか違わない字形（合成フォントの 3 と 9 は距離 12）を
    // まとめてしまうと数字を誤読する。誤読より入力が増えるほうが安全なので
    // 小さめに取り、同じ数字がいくつかに分かれるのは許容する。
    MAX_DIST: 10,
    // 縦横比がこれ以上違う字形は、塗りが似ていても別の字とみなす。
    // 細い「1」(0.90x3.54 = 0.25) が、図面の縦線の破片(幅0 = 0.00)と
    // 距離8でまとまってしまい X1/X10/X11 が読めなくなっていた。
    ASPECT_TOL: 0.12,
    MIN_SHAPE_COUNT: 1, // 一覧に出す形の最小出現回数
  };

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
      // 曲線を折れ線に割ったものも文字の一部（0 や 6 の丸み）。捨ててはいけない。
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

  // 形の指紋。実図面では同じ文字でも座標が僅かに揺れるため、ストロークの座標を
  // そのまま比べると同じ数字がいくつもの形に分裂する。長辺を基準に正方形へ
  // 正規化してから粗い格子に塗り、その塗り分け（ビット列）を指紋にする。
  // 縦横比は保つので「1」と「0」は別の形になる。
  // 照合は完全一致ではなく、ずれたビット数（ハミング距離）で行う（matchShape）。
  function bitsOf(glyph) {
    const n = PARAMS.GRID;
    const words = new Uint32Array(Math.ceil((n * n) / 32));
    const base = Math.max(glyph.w, glyph.h) || 1;
    const ox = glyph.x0 - (base - glyph.w) / 2;
    const oy = glyph.y0 - (base - glyph.h) / 2;
    const cell = base / n;
    const reach = cell * PARAMS.INK;
    for (const s of glyph.segs) {
      const gx0 = Math.max(0, Math.floor((Math.min(s.x1, s.x2) - reach - ox) / cell));
      const gx1 = Math.min(n - 1, Math.floor((Math.max(s.x1, s.x2) + reach - ox) / cell));
      const gy0 = Math.max(0, Math.floor((Math.min(s.y1, s.y2) - reach - oy) / cell));
      const gy1 = Math.min(n - 1, Math.floor((Math.max(s.y1, s.y2) + reach - oy) / cell));
      for (let gy = gy0; gy <= gy1; gy++) {
        for (let gx = gx0; gx <= gx1; gx++) {
          const i = gy * n + gx;
          if (words[i >> 5] & (1 << (i & 31))) continue;
          if (distPointSeg(ox + (gx + 0.5) * cell, oy + (gy + 0.5) * cell, s) <= reach) {
            words[i >> 5] |= 1 << (i & 31);
          }
        }
      }
    }
    return words;
  }

  function bitsToHex(words) {
    let out = "";
    for (let i = 0; i < words.length; i++) out += (words[i] >>> 0).toString(16).padStart(8, "0");
    return out;
  }

  function hexToBits(key) {
    const i = String(key).indexOf(".");
    const hex = i < 0 ? String(key) : String(key).slice(0, i);
    const n = Math.ceil(hex.length / 8);
    const words = new Uint32Array(n);
    for (let i = 0; i < n; i++) words[i] = parseInt(hex.slice(i * 8, i * 8 + 8), 16) >>> 0;
    return words;
  }

  function popcount(v) {
    v = v - ((v >> 1) & 0x55555555);
    v = (v & 0x33333333) + ((v >> 2) & 0x33333333);
    return (((v + (v >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24;
  }

  // 2つの指紋のずれ（塗りが違う格子の数）
  function shapeDistance(a, b) {
    let d = 0;
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) d += popcount(((a[i] || 0) ^ (b[i] || 0)) >>> 0);
    return d;
  }

  // 指紋の鍵は「塗りのビット列.縦横比」。縦横比は照合時の足切りに使う。
  function shapeOf(glyph) {
    const base = Math.max(glyph.w, glyph.h) || 1;
    const aspect = Math.min(glyph.w, glyph.h) / base;
    return bitsToHex(bitsOf(glyph)) + "." + aspect.toFixed(3);
  }

  function aspectOfKey(key) {
    const i = String(key).indexOf(".");
    return i < 0 ? -1 : Number(key.slice(i + 1));
  }

  function aspectOfGlyph(glyph) {
    const base = Math.max(glyph.w, glyph.h) || 1;
    return Math.min(glyph.w, glyph.h) / base;
  }

  // 指紋の一覧（対応表の鍵）から一番近いものを選ぶ。離れていれば null。
  // aspect を渡すと、縦横比が違いすぎる鍵は候補から外す。
  function matchShape(bits, keyBits, aspect) {
    let best = null;
    let bestD = PARAMS.MAX_DIST + 1;
    for (const k in keyBits) {
      if (aspect != null) {
        const a = aspectOfKey(k);
        if (a >= 0 && Math.abs(a - aspect) > PARAMS.ASPECT_TOL) continue;
      }
      const d = shapeDistance(bits, keyBits[k]);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    return best;
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
    // 指紋が僅かに違うだけの字形をまとめる（実図面では同じ数字でも座標が揺れる）
    const reps = [];
    for (const g of glyphs) {
      g.bits = bitsOf(g);
      g.aspect = aspectOfGlyph(g);
      let best = null;
      let bestD = PARAMS.MAX_DIST + 1;
      for (const r of reps) {
        if (Math.abs(r.aspect - g.aspect) > PARAMS.ASPECT_TOL) continue;
        const d = shapeDistance(g.bits, r.bits);
        if (d < bestD) {
          bestD = d;
          best = r;
        }
      }
      if (best) {
        best.count++;
        g.shape = best.shape;
      } else {
        const rep = { shape: shapeOf(g), bits: g.bits, aspect: g.aspect, glyph: g, count: 1 };
        reps.push(rep);
        g.shape = rep.shape;
      }
    }
    const runs = buildRuns(glyphs);
    // 一覧に出すのは「2文字以上の行」に入った字形だけ。図面の線の破片が
    // 1文字の行として大量に残るため、これを外すと一覧が埋まって使えない
    // （実図面で 93種 → 64種）。寸法も符号も2文字以上なので取りこぼさない。
    const inRuns = new Map();
    for (const r of runs) {
      if (r.glyphs.length < 2) continue;
      for (const g of r.glyphs) inRuns.set(g.shape, (inRuns.get(g.shape) || 0) + 1);
    }
    const shapes = reps
      .filter((r) => (inRuns.get(r.shape) || 0) >= PARAMS.MIN_SHAPE_COUNT)
      .map((r) => ({ shape: r.shape, count: inRuns.get(r.shape) || 0, glyph: r.glyph, rot: rotations(r.glyph) }))
      .sort((a, b) => b.count - a.count || (a.shape < b.shape ? -1 : 1));
    // この図面のふつうの字高。教える画面で字形を実寸比で描くのに使う
    // （小数点を枠いっぱいに伸ばすと線の破片と見分けが付かない）
    const hs = [];
    for (const r of runs) {
      if (r.glyphs.length < 2) continue;
      for (const g of r.glyphs) if (g.seed) hs.push(Math.max(g.w, g.h));
    }
    hs.sort((a, b) => a - b);
    const refHeight = hs.length ? hs[hs.length >> 1] : 0;
    return { glyphs, runs, shapes, refHeight };
  }

  // 形→文字の対応表で、行を文字列にする。
  // 1文字でも対応が無い行は捨てる（半端な数字を読むほうが危ないため）。
  function toTexts(runs, map) {
    const out = [];
    if (!map) return out;
    // 対応表の鍵をビット列にしておき、一番近い鍵で引く。
    // 完全一致にすると、別の図面（同じフォント）で僅かに座標が違うだけで読めなくなる。
    const keyBits = {};
    for (const k in map) if (map[k]) keyBits[k] = hexToBits(k);
    if (!Object.keys(keyBits).length) return out;
    const cache = new Map();
    const lookup = (g) => {
      if (cache.has(g.shape)) return cache.get(g.shape);
      const key = matchShape(g.bits || bitsOf(g), keyBits, g.aspect != null ? g.aspect : aspectOfGlyph(g));
      const ch = key ? map[key] : null;
      cache.set(g.shape, ch);
      return ch;
    };
    for (const run of runs) {
      let str = "";
      let ok = true;
      for (const g of run.glyphs) {
        const ch = lookup(g);
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
  // 教える画面に出す字形のパス。ref（その図面の標準的な字高）を渡すと
  // **実際の大きさの比で**描く。小数点のような小さな字形を単独で枠いっぱいに
  // 引き伸ばすと、ただの点や線の破片と見分けが付かず教えようがないため。
  function shapePath(glyph, size, ref) {
    const s = size || 24;
    const own = Math.max(glyph.w, glyph.h) || 1;
    // ref があればそれを基準に。ref より大きい字形は枠に収まるよう own で割る
    const base = ref && ref > 0 ? Math.max(ref, own) : own;
    const sc = (s - 4) / base;
    const ox = 2 + ((s - 4) - glyph.w * sc) / 2; // 横は中央、縦はベースライン合わせ
    const parts = [];
    for (const seg of glyph.segs) {
      const x1 = (seg.x1 - glyph.x0) * sc + ox;
      const y1 = s - 2 - (seg.y1 - glyph.y0) * sc;
      const x2 = (seg.x2 - glyph.x0) * sc + ox;
      const y2 = s - 2 - (seg.y2 - glyph.y0) * sc;
      parts.push(`M${r2(x1)} ${r2(y1)}L${r2(x2)} ${r2(y2)}`);
    }
    return parts.join("");
  }

  ZC.glyph = {
    extract,
    toTexts,
    bitsOf,
    hexToBits,
    aspectOfKey,
    aspectOfGlyph,
    shapeDistance,
    matchShape,
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
