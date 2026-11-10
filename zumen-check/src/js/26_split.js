// 分割図面の認識と統合。
// 1 つの建物を上下（または左右）に分けて複数ページに描いた図面（平面詳細図など）を、
// 1 枚ぶんの拾い出し結果にまとめて、分割していない図面（構造図など）と照合できるようにする。
(function (ZC) {
  "use strict";

  const SIDES = ZC.axis.SIDES;
  const SIDE_NAME = ZC.axis.SIDE_NAME;

  const PARAMS = {
    SAME_MIN: 0.8, // 「ページ間で同じ範囲」とみなす一致率（Jaccard）
    DIFF_MAX: 0.75, // 「ページ間で違う範囲」とみなす一致率の上限
    VALUE_TOL: 0.5, // ページ間で同じ区間の記載値が食い違ったとみなす差(mm)
    SIDE_MATCH: 0.6, // 「同じ辺に符号を書いている」とみなす本数の比
  };

  // 符号の番号部分（X2.2 → 2.2）。並べ替えに使う
  function num(label) {
    const m = /^[XY](\d+(?:\.\d+)?)$/.exec(String(label));
    return m ? Number(m[1]) : NaN;
  }

  function byLabelOrder(a, b) {
    const d = num(a) - num(b);
    if (!isNaN(d) && d !== 0) return d;
    return a < b ? -1 : a > b ? 1 : 0;
  }

  // その図面に出てくる方向別の符号（4辺のどこかにバブルがあるもの）
  function labelsOf(sides, dir) {
    const set = new Set();
    for (const k of SIDES) {
      const s = sides && sides[k];
      if (!s || s.dir !== dir) continue;
      for (const a of s.axes) if (a.label != null) set.add(a.label);
    }
    return set;
  }

  function jaccard(a, b) {
    if (!a.size && !b.size) return 1;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter);
  }

  const sortLabels = (set) => [...set].sort(byLabelOrder);

  // pages: [{page, sides}]（sides は ZC.sides.build の結果）
  // 戻り値: {split, dir, name, parts, union, common, overlap, reason}
  //   dir "h" … 横方向の芯（Y）の範囲がページごとに違う = 上下に分けてある
  //   dir "v" … 縦方向の芯（X）の範囲がページごとに違う = 左右に分けてある
  function detect(pages) {
    const list = (pages || []).filter((p) => p && p.sides);
    if (list.length < 2) return { split: false, reason: "ページが1つしかありません" };
    const info = list.map((p) => ({
      page: p.page,
      v: labelsOf(p.sides, "v"),
      h: labelsOf(p.sides, "h"),
    }));
    if (info.some((i) => !i.v.size || !i.h.size)) {
      return { split: false, reason: "縦横どちらかの通り芯が読めないページがあります" };
    }
    const minJ = (dir) => {
      let m = 1;
      for (let i = 0; i < info.length; i++) {
        for (let j = i + 1; j < info.length; j++) m = Math.min(m, jaccard(info[i][dir], info[j][dir]));
      }
      return m;
    };
    const jv = minJ("v");
    const jh = minJ("h");
    const dir = jv <= jh ? "v" : "h"; // 範囲がそろっていないほうが分割方向
    const jd = dir === "v" ? jv : jh;
    const jo = dir === "v" ? jh : jv;
    if (jo < PARAMS.SAME_MIN) {
      return { split: false, reason: "ページごとに通り芯の範囲が縦横とも違います（別の図面どうしの可能性）" };
    }
    if (jd > PARAMS.DIFF_MAX) {
      return { split: false, reason: "ページどうしで通り芯の範囲がほぼ同じです" };
    }

    // 分割方向の符号をすべて集め、各ページがその「連続したひと続き」になっているか見る
    const union = new Set();
    for (const i of info) for (const l of i[dir]) union.add(l);
    const all = sortLabels(union);
    const idx = new Map(all.map((l, i) => [l, i]));
    const other = dir === "v" ? "h" : "v";
    const parts = info
      .map((i) => {
        const ls = sortLabels(i[dir]);
        const from = idx.get(ls[0]);
        const to = idx.get(ls[ls.length - 1]);
        const contiguous = ls.every((l, k) => idx.get(l) === from + k);
        return { page: i.page, labels: ls, from, to, contiguous, common: sortLabels(i[other]) };
      })
      .sort((a, b) => a.from - b.from || a.page - b.page);
    if (parts.some((p) => !p.contiguous)) {
      return { split: false, reason: "ページごとの通り芯がとびとびで、分けかたが読み取れません" };
    }
    for (let i = 1; i < parts.length; i++) {
      if (parts[i].from > parts[i - 1].to + 1) {
        return { split: false, reason: "ページのあいだに抜けている通り芯があります" };
      }
    }
    const overlap = [];
    for (let i = 1; i < parts.length; i++) {
      for (let k = parts[i].from; k <= Math.min(parts[i].to, parts[i - 1].to); k++) overlap.push(all[k]);
    }
    return {
      split: true,
      dir,
      // 横方向の芯（Y）で分かれている = 上下に切ってある
      name: (dir === "h" ? "上下" : "左右") + parts.length + "分割",
      parts,
      union: all,
      common: sortLabels(info[0][dir === "v" ? "h" : "v"]),
      overlap: [...new Set(overlap)],
    };
  }

  // 分割の説明文（画面と CLI で共用）
  function describe(info) {
    if (!info || !info.split) return "";
    const dirName = info.dir === "h" ? "上下" : "左右";
    const lines = [
      "この図面は1つの建物を" + dirName + "に" + info.parts.length + "分割して描いています。",
    ];
    for (const p of info.parts) {
      lines.push(
        "  " + p.page + "ページ目: " + p.labels[0] + "〜" + p.labels[p.labels.length - 1] +
          "（" + p.labels.length + "本）"
      );
    }
    if (info.overlap.length) lines.push("  重なり: " + info.overlap.join(" "));
    return lines.join("\n");
  }

  // 複数の「辺」を 1 つにまとめる共通処理。
  //   ページをまたぐ統合（1ページ目の上辺 + 2ページ目の上辺）にも、
  //   方向でまとめる統合（上辺 + 下辺 → X方向）にも使う。
  // list: [{tag, side}]  tag は食い違いの出どころを示す印（ページ番号や辺の名前）
  function mergeSideObjects(list, key, name, dir, conflicts) {
    const byLabel = new Map();
    for (const { side } of list) {
      for (const a of side.axes) if (a.label != null && !byLabel.has(a.label)) byLabel.set(a.label, a);
    }
    const axes = [...byLabel.keys()].sort(byLabelOrder).map((l) => byLabel.get(l));

    const spanMap = new Map();
    for (const { tag, side } of list) {
      for (const sp of side.spans.concat(side.extra || [])) {
        const k = sp.from + "~" + sp.to;
        const prev = spanMap.get(k);
        if (!prev) {
          spanMap.set(k, {
            from: sp.from, to: sp.to, fromAx: sp.fromAx, toAx: sp.toAx,
            value: sp.value, parts: sp.parts, conflict: !!sp.conflict, tags: [tag],
          });
          continue;
        }
        prev.tags.push(tag);
        if (prev.value == null && sp.value != null) {
          prev.value = sp.value;
          prev.parts = sp.parts;
          prev.fromAx = sp.fromAx;
          prev.toAx = sp.toAx;
        } else if (prev.value != null && sp.value != null &&
                   Math.abs(prev.value - sp.value) > PARAMS.VALUE_TOL) {
          prev.conflict = true;
          if (conflicts) {
            conflicts.push({ side: key, name, item: k, values: [prev.value, sp.value], tags: prev.tags.slice() });
          }
        }
      }
    }

    // まとめた並びで隣り合う区間。無い区間は「記載なし」で埋める
    const spans = [];
    for (let i = 0; i + 1 < axes.length; i++) {
      const k = axes[i].label + "~" + axes[i + 1].label;
      const got = spanMap.get(k);
      if (got) {
        spans.push(got);
        spanMap.delete(k);
      } else {
        spans.push({
          from: axes[i].label, to: axes[i + 1].label, fromAx: axes[i], toAx: axes[i + 1],
          value: null, parts: null, conflict: false, tags: [],
        });
      }
    }
    // 隣り合わなくなった区間（細分する前の通し寸法など）も照合に使えるよう残す
    const extra = [...spanMap.values()];

    let total = null;
    if (axes.length >= 2) {
      const first = axes[0].label;
      const last = axes[axes.length - 1].label;
      const whole = extra.find((sp) => sp.from === first && sp.to === last);
      if (whole && whole.value != null) {
        total = { from: first, to: last, value: whole.value, parts: whole.parts };
      } else {
        const vals = spans.map((sp) => sp.value);
        const sum = vals.every((v) => v != null) ? vals.reduce((a, b) => a + b, 0) : null;
        total = { from: first, to: last, value: sum, parts: sum != null ? vals.slice() : null, summed: sum != null };
      }
    }
    return { side: key, name, dir, axes, spans, extra, total, entryCount: 0, merged: true };
  }

  // 分割されたページを 1 枚ぶんの拾い出し結果（sides 相当）にまとめる。
  // 符号は番号順に並べ直し、区間はページをまたいで同じ区間を 1 つにする。
  // 同じ区間の記載値がページ間で食い違ったら conflict を立てる（図面自体の不整合）。
  function merge(pages) {
    const list = (pages || []).filter((p) => p && p.sides);
    const out = {};
    const conflicts = [];
    for (const key of SIDES) {
      const dir = key === "top" || key === "bottom" ? "v" : "h";
      const parts = list.filter((p) => p.sides[key]).map((p) => ({ tag: p.page + "ページ目", side: p.sides[key] }));
      out[key] = parts.length
        ? mergeSideObjects(parts, key, SIDE_NAME[key], dir, conflicts)
        : { side: key, name: SIDE_NAME[key], dir, axes: [], spans: [], extra: [], total: null, entryCount: 0, merged: true };
    }
    Object.defineProperty(out, "used", { value: new Set(), enumerable: false });
    Object.defineProperty(out, "conflicts", { value: conflicts, enumerable: false });
    return out;
  }

  // 辺ではなく「方向」でまとめる（上辺+下辺 → X方向 / 右辺+左辺 → Y方向）。
  // 平面図と構造図のように**符号を書く辺が違う図面どうし**を照合するときに使う。
  // 辺ごとに照合すると「構造図は符号を下辺にしか書かない」というだけで
  // 符号の食い違いが大量に出てしまい、本当の差異が埋もれる。
  // 上辺と下辺で同じ区間の値が違えばその図面自体の不整合なので conflict を立てる。
  function byDirection(sides) {
    const out = {};
    const conflicts = [];
    const DIRS = [
      ["x", "X方向", "v", ["top", "bottom"]],
      ["y", "Y方向", "h", ["right", "left"]],
    ];
    for (const [key, name, dir, pair] of DIRS) {
      const parts = pair
        .filter((k) => sides[k] && sides[k].axes.length)
        .map((k) => ({ tag: sides[k].name, side: sides[k] }));
      out[key] = parts.length
        ? mergeSideObjects(parts, key, name, dir, conflicts)
        : { side: key, name, dir, axes: [], spans: [], extra: [], total: null, entryCount: 0, merged: true };
    }
    Object.defineProperty(out, "used", { value: (sides && sides.used) || new Set(), enumerable: false });
    Object.defineProperty(out, "conflicts", {
      value: ((sides && sides.conflicts) || []).concat(conflicts), enumerable: false,
    });
    return out;
  }

  // 「辺ごと」と「方向ごと」のどちらで照合すべきかを決める。
  // 図面の種類が違うと**符号を書く辺が違う**ことがあり（平面図は4辺、構造図は
  // 下辺と左辺だけ）、辺ごとに照合すると「構造図の上辺に符号が無い」という
  // 書き方の違いだけで大量に NG が出て、本当の差異が埋もれる。
  // どこか1辺でも本数が大きく食い違えば、方向ごとにまとめて照合する。
  function pickUnit(baseSides, cmpSides) {
    const diffs = [];
    for (const k of SIDES) {
      const nb = ((baseSides && baseSides[k] && baseSides[k].axes) || []).length;
      const nc = ((cmpSides && cmpSides[k] && cmpSides[k].axes) || []).length;
      const hi = Math.max(nb, nc);
      const lo = Math.min(nb, nc);
      if (hi >= 2 && lo < hi * PARAMS.SIDE_MATCH) {
        diffs.push({ side: k, name: SIDE_NAME[k], base: nb, cmp: nc });
      }
    }
    return {
      unit: diffs.length ? "dir" : "side",
      diffs,
      reason: diffs.length
        ? "符号を書いている辺が図面どうしで違います（" +
          diffs.map((d) => d.name + " 基準" + d.base + "本/比較" + d.cmp + "本").join("・") +
          "）。辺ごとだと書き方の違いが差異として出るため、方向ごとにまとめて照合します。"
        : "両方の図面が同じ辺に符号を書いているので、辺ごとに照合します。",
    };
  }

  ZC.split = { detect, describe, merge, byDirection, mergeSideObjects, pickUnit, num, PARAMS };
})(globalThis.ZC = globalThis.ZC || {});
