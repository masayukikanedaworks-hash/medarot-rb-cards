// 照合: 辺（上辺/下辺/左辺/右辺）ごとに、通り芯の並びと「図面に記載された寸法」を突き合わせる。
// 縮尺は使わない。寸法は記載値どうしの比較のみ。
(function (ZC) {
  "use strict";

  const F = ZC.sides.fmtVal;

  // base / cmp: {sides: ZC.sides.build(...), name}
  // opts: {tol, checks:{labels, spacing, total}}
  function compare(base, cmp, opts) {
    const tol = opts && opts.tol > 0 ? opts.tol : 1;
    const checks = (opts && opts.checks) || {};
    const rows = [];

    for (const key of ["top", "right", "bottom", "left"]) {
      const b = base.sides[key];
      const c = cmp.sides[key];
      if (!b || !c) continue;
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
              { b: b.axes, c: c.axes }
            )
          );
        }
      }

      if (checks.spacing !== false) {
        const cByKey = new Map(c.spans.map((s) => [s.from + "~" + s.to, s]));
        const seen = new Set();
        for (const bs of b.spans) {
          const k = bs.from + "~" + bs.to;
          seen.add(k);
          const cs = cByKey.get(k);
          pushSpanRow(rows, sideName, "芯々寸法", k, bs, cs, tol);
        }
        for (const cs of c.spans) {
          const k = cs.from + "~" + cs.to;
          if (seen.has(k)) continue;
          pushSpanRow(rows, sideName, "芯々寸法", k, null, cs, tol);
        }
      }

      if (checks.total !== false && b.total && c.total) {
        const k = b.total.from + "~" + b.total.to;
        pushSpanRow(rows, sideName, "全体寸法", k, b.total, c.total, tol);
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

  function pushSpanRow(rows, sideName, check, item, bs, cs, tol) {
    const bv = bs ? bs.value : null;
    const cv = cs ? cs.value : null;
    const notes = [];
    if (bs && bs.parts && bs.parts.length > 1) notes.push("基準=" + bs.parts.map(F).join("+"));
    if (cs && cs.parts && cs.parts.length > 1) notes.push("比較=" + cs.parts.map(F).join("+"));
    if (bs && bs.conflict) notes.push("基準の寸法段で値が食い違い");
    if (cs && cs.conflict) notes.push("比較の寸法段で値が食い違い");

    let status;
    let diff = null;
    if (bv == null && cv == null) {
      status = "WARN";
      notes.push("両図面ともこの辺に記載寸法が見つかりません");
    } else if (bv == null || cv == null) {
      status = "WARN";
      notes.push((bv == null ? "基準" : "比較") + "にこの区間の記載寸法が見つかりません");
    } else {
      diff = cv - bv;
      status = Math.abs(diff) <= tol ? "OK" : "NG";
    }
    if (!bs) notes.push("基準にこの区間がありません");
    if (!cs) notes.push("比較にこの区間がありません");
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
        }
      )
    );
  }

  function row(sideName, check, item, baseVal, cmpVal, diff, status, note, refs) {
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
    return r;
  }

  ZC.compare = { compare };
})(globalThis.ZC = globalThis.ZC || {});
