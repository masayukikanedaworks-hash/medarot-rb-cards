// 照合: 辺（上辺/下辺/左辺/右辺）ごとに、通り芯の並びと「図面に記載された寸法」を突き合わせる。
// 縮尺は使わない。寸法は記載値どうしの比較のみ。
(function (ZC) {
  "use strict";

  const F = ZC.sides.fmtVal;

  // その辺の区間を区間名で引けるようにする。merged な辺は「隣り合わなくなった区間」
  // （分割前の通し寸法）も持っているので、それも引けるようにする。
  function spanIndex(side) {
    const m = new Map();
    for (const sp of (side.spans || []).concat(side.extra || [])) {
      const k = sp.from + "~" + sp.to;
      if (!m.has(k) || (m.get(k).value == null && sp.value != null)) m.set(k, sp);
    }
    return m;
  }

  // 片方にしか無い区間を、もう片方の「連続した区間の合計」で作る。
  // 通り芯の細分がページや図面で違う場合（平面図は X2~X2.2 + X2.2~X3、
  // 構造図は X2~X3）に、同じ範囲どうしを比べられるようにするため。
  // 合計するのはどちらも**図面に記載された値**なので、縮尺不使用の方針は崩れない。
  function chainSpan(side, from, to) {
    const order = side.axes.map((a) => a.label);
    const i = order.indexOf(from);
    const j = order.indexOf(to);
    if (i < 0 || j < 0 || j <= i + 1) return null;
    const idx = spanIndex(side);
    const parts = [];
    for (let k = i; k < j; k++) {
      const sp = idx.get(order[k] + "~" + order[k + 1]);
      if (!sp || sp.value == null) return null;
      parts.push(sp.value);
    }
    return {
      from, to,
      fromAx: side.axes[i], toAx: side.axes[j],
      value: parts.reduce((a, b) => a + b, 0),
      parts,
      conflict: false,
      chain: true,
    };
  }

  // base / cmp: {sides: ZC.sides.build(...), name}
  // opts: {tol, checks:{labels, spacing, total}}
  function compare(base, cmp, opts) {
    const tol = opts && opts.tol > 0 ? opts.tol : 1;
    const checks = (opts && opts.checks) || {};
    const rows = [];

    // 辺（top/right/bottom/left）でも方向（x/y）でも照合できるよう、
    // 両方にある区分を順に回す（ZC.split.byDirection は x/y を返す）
    const ORDER = { top: 0, right: 1, bottom: 2, left: 3 };
    const keys = Object.keys(base.sides).filter((k) => cmp.sides[k]);
    keys.sort((a, b) => (ORDER[a] == null ? 9 : ORDER[a]) - (ORDER[b] == null ? 9 : ORDER[b]));
    for (const key of keys) {
      const b = base.sides[key];
      const c = cmp.sides[key];
      if (!b || !c || !b.axes || !c.axes) continue;
      const sideName = b.name;

      if (checks.labels !== false) {
        const bl = b.axes.map((a) => a.label);
        const cl = c.axes.map((a) => a.label);
        const bSet = new Set(bl);
        const cSet = new Set(cl);
        const onlyB = bl.filter((l) => !cSet.has(l));
        const onlyC = cl.filter((l) => !bSet.has(l));
        for (const l of onlyB) {
          rows.push(
            row(sideName, "通り芯", l, "あり", "なし", null, "NG", "比較図面のこの辺に同じ符号がありません", {
              b: b.axes.filter((a) => a.label === l),
              c: [],
            })
          );
        }
        for (const l of onlyC) {
          rows.push(
            row(sideName, "通り芯", l, "なし", "あり", null, "NG", "基準図面のこの辺に同じ符号がありません", {
              b: [],
              c: c.axes.filter((a) => a.label === l),
            })
          );
        }
        if (!onlyB.length && !onlyC.length && bl.length) {
          const sameOrder = bl.join(",") === cl.join(",");
          rows.push(
            row(
              sideName,
              "通り芯",
              "全" + bl.length + "本",
              bl.join(" "),
              sameOrder ? "一致" : cl.join(" "),
              null,
              sameOrder ? "OK" : "NG",
              sameOrder ? "" : "並び順が異なります",
              { b: b.axes, c: c.axes },
              "all"
            )
          );
        }
      }

      if (checks.spacing !== false) {
        const bByKey = spanIndex(b);
        const cByKey = spanIndex(c);
        const seen = new Set();
        // 相手側にその符号自体が無いのか、符号はあるが寸法が読めないのかを
        // 区別して注記する（細分の有無が違う図面どうしで何が起きているか分かるように）
        const bHas = new Set(b.axes.map((a) => a.label));
        const cHas = new Set(c.axes.map((a) => a.label));
        const miss = (sp, has, who) =>
          sp ? [sp.from, sp.to].filter((l) => !has.has(l)).map((l) => who + "に " + l + " の通り芯がありません") : [];
        for (const bs of b.spans) {
          const k = bs.from + "~" + bs.to;
          seen.add(k);
          const cs = cByKey.get(k) || chainSpan(c, bs.from, bs.to);
          pushSpanRow(rows, sideName, "芯々寸法", k, bs, cs, tol, miss(bs, cHas, "比較図面"));
        }
        for (const cs of c.spans) {
          const k = cs.from + "~" + cs.to;
          if (seen.has(k)) continue;
          seen.add(k);
          const bs = bByKey.get(k) || chainSpan(b, cs.from, cs.to);
          pushSpanRow(rows, sideName, "芯々寸法", k, bs, cs, tol, miss(cs, bHas, "基準図面"));
        }
      }

      if (checks.total !== false && b.total && c.total) {
        const k = b.total.from + "~" + b.total.to;
        pushSpanRow(rows, sideName, "全体寸法", k, b.total, c.total, tol, null, "all");
      }
    }

    const summary = { ok: 0, ng: 0, warn: 0 };
    for (const r of rows) {
      if (r.status === "OK") summary.ok++;
      else if (r.status === "NG") summary.ng++;
      else summary.warn++;
    }
    return { rows, summary };
  }

  function pushSpanRow(rows, sideName, check, item, bs, cs, tol, missing, scope) {
    const bv = bs ? bs.value : null;
    const cv = cs ? cs.value : null;
    const notes = [];
    // 相手にこの符号自体が無い場合は、寸法が読めないのではなく細分の違い
    const noAxis = (missing || []).length > 0;
    if (noAxis) notes.push(missing.join(" / "));
    if (bs && bs.parts && bs.parts.length > 1) notes.push("基準=" + bs.parts.map(F).join("+"));
    if (cs && cs.parts && cs.parts.length > 1) notes.push("比較=" + cs.parts.map(F).join("+"));
    if (bs && bs.conflict) notes.push("基準の寸法段で値が食い違い");
    if (cs && cs.conflict) notes.push("比較の寸法段で値が食い違い");
    if (bs && bs.chain) notes.push("基準は細分された区間の合計");
    if (cs && cs.chain) notes.push("比較は細分された区間の合計");
    if (bs && bs.summed) notes.push("基準は区間の合計");
    if (cs && cs.summed) notes.push("比較は区間の合計");

    let status;
    let diff = null;
    if (bv == null && cv == null) {
      status = "WARN";
      notes.push("両図面ともこの辺に記載寸法が見つかりません");
    } else if (bv == null || cv == null) {
      status = "WARN";
      if (!noAxis) notes.push((bv == null ? "基準" : "比較") + "にこの区間の記載寸法が見つかりません");
    } else {
      diff = cv - bv;
      status = Math.abs(diff) <= tol ? "OK" : "NG";
    }
    if (!bs && !noAxis) notes.push("基準にこの区間がありません");
    if (!cs && !noAxis) notes.push("比較にこの区間がありません");
    rows.push(
      row(
        sideName,
        check,
        item,
        bv == null ? "—" : F(bv),
        cv == null ? "—" : F(cv),
        diff,
        status,
        notes.join(" / "),
        {
          b: bs ? [bs.fromAx, bs.toAx].filter(Boolean) : [],
          c: cs ? [cs.fromAx, cs.toAx].filter(Boolean) : [],
          bs: bs || null, // 図上でその寸法の数字だけを塗るのに使う
          cs: cs || null,
        },
        scope
      )
    );
  }

  function row(sideName, check, item, baseVal, cmpVal, diff, status, note, refs, scope) {
    const r = {
      side: sideName,
      check,
      item,
      base: baseVal,
      cmp: cmpVal,
      diff: diff == null ? null : diff,
      status,
      note: note || "",
    };
    if (refs) {
      // UI がビュワー強調に使う芯オブジェクト参照。列挙不可にして JSON/CSV には出さない
      Object.defineProperty(r, "refs", { value: refs, enumerable: false });
    }
    // scope "all" は図面全体にかかる行（符号の一覧・全体寸法）。
    // ビュワーの色付けはこれを塗らない（図面が丸ごと埋まってしまうため）
    if (scope) Object.defineProperty(r, "scope", { value: scope, enumerable: false });
    return r;
  }

  ZC.compare = { compare, chainSpan, spanIndex };
})(globalThis.ZC = globalThis.ZC || {});
