// 照合: 基準図面と比較図面の通り芯を対応付け、符号・芯々寸法・全体寸法の差異を洗い出す。
// 芯々寸法・全体寸法は「図面に記載された寸法値（黒ドット間の注記、分割は合計）」を第一に使い、
// 注記が見つからない側だけ作図距離×縮尺で補う。
(function (ZC) {
  "use strict";

  const U = ZC.util;

  const PARAMS = {
    MATCH_TOL_MM: 25, // 位置による対応付けの最大ずれ(mm)
  };

  const DIR_NAME = { v: "縦(X方向の並び)", h: "横(Y方向の並び)" };

  // side: {v:[axes], h:[axes], mmPerPt, entries, name}
  // opts: {tol, checks:{labels, spacing, total, dims}}
  function compare(base, cmp, opts) {
    const tol = opts.tol > 0 ? opts.tol : 1;
    const checks = opts.checks || {};
    const rows = [];

    for (const dir of ["v", "h"]) {
      const bList = prep(base[dir], base.mmPerPt);
      const cList = prep(cmp[dir], cmp.mmPerPt);
      const { matches, bOnly, cOnly } = matchAxes(bList, cList);

      if (checks.labels !== false) {
        let ngCount = 0;
        for (const m of matches) {
          if (m.b.label != null && m.c.label != null && m.b.label !== m.c.label) {
            rows.push(
              row("符号", dir, m.b.name + " ↔ " + m.c.name, m.b.label, m.c.label, null, "NG", "符号が一致しません", {
                b: [m.b.ax],
                c: [m.c.ax],
              })
            );
            ngCount++;
          }
        }
        for (const b of bOnly) {
          rows.push(
            row("符号", dir, b.name, "あり", "なし", null, b.label != null ? "NG" : "WARN", "比較図面に対応する芯がありません", {
              b: [b.ax],
              c: [],
            })
          );
          ngCount++;
        }
        for (const c of cOnly) {
          rows.push(
            row("符号", dir, c.name, "なし", "あり", null, c.label != null ? "NG" : "WARN", "基準図面に対応する芯がありません", {
              b: [],
              c: [c.ax],
            })
          );
          ngCount++;
        }
        if (!ngCount && matches.length) {
          rows.push(
            row("符号", dir, "全" + matches.length + "本", matches.map((m) => m.b.name).join(" "), "対応あり", null, "OK", "", {
              b: matches.map((m) => m.b.ax),
              c: matches.map((m) => m.c.ax),
            })
          );
        }
      }

      if (checks.spacing !== false) {
        for (let i = 0; i + 1 < matches.length; i++) {
          const p = matches[i];
          const q = matches[i + 1];
          const bv = pairValue(base, dir, p.b, q.b);
          const cv = pairValue(cmp, dir, p.c, q.c);
          pushValueRow(rows, "芯々寸法", dir, p, q, bv, cv, tol);
        }
      }

      if (checks.total !== false && matches.length >= 2) {
        const p = matches[0];
        const q = matches[matches.length - 1];
        const bv = pairValue(base, dir, p.b, q.b);
        const cv = pairValue(cmp, dir, p.c, q.c);
        pushValueRow(rows, "全体寸法", dir, p, q, bv, cv, tol);
      }
    }

    // 記載寸法と作図位置の食い違い（各図面ごと・注記が読めた区間のみ）
    if (checks.dims) {
      for (const side of [base, cmp]) {
        const isBase = side === base;
        for (const dir of ["v", "h"]) {
          const list = prep(side[dir], side.mmPerPt);
          for (let i = 0; i + 1 < list.length; i++) {
            const a = list[i];
            const b = list[i + 1];
            const annot = ZC.dims.spanValue(side.entries || [], dir, a.ax.pos, b.ax.pos);
            if (!annot) continue;
            const geom = b.mm - a.mm;
            const diff = geom - annot.value;
            rows.push(
              row(
                "寸法値整合(" + side.name + ")",
                dir,
                a.name + "〜" + b.name,
                U.fmtMm(annot.value),
                U.fmtMm(geom),
                diff,
                Math.abs(diff) <= tol ? "OK" : "NG",
                "記載寸法" + partsNote(annot) + "と作図上の距離×縮尺の比較",
                { b: isBase ? [a.ax, b.ax] : [], c: isBase ? [] : [a.ax, b.ax] }
              )
            );
          }
        }
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

  // 芯ペア間の値: 記載寸法（分割は合計）を優先し、無ければ作図距離×縮尺
  function pairValue(side, dir, a, b) {
    const annot = ZC.dims.spanValue(side.entries || [], dir, a.ax.pos, b.ax.pos);
    if (annot) {
      return { value: annot.value, parts: annot.parts, conflict: annot.conflict, annotated: true };
    }
    return { value: Math.abs(b.mm - a.mm), parts: null, conflict: false, annotated: false };
  }

  function pushValueRow(rows, check, dir, p, q, bv, cv, tol) {
    const diff = cv.value - bv.value;
    const notes = [];
    if (bv.parts && bv.parts.length > 1) notes.push("基準=" + bv.parts.join("+"));
    if (cv.parts && cv.parts.length > 1) notes.push("比較=" + cv.parts.join("+"));
    if (!bv.annotated && !cv.annotated) notes.push("記載寸法が見つからないため作図距離×縮尺で比較");
    else if (!bv.annotated) notes.push("基準は記載寸法が見つからず作図距離×縮尺");
    else if (!cv.annotated) notes.push("比較は記載寸法が見つからず作図距離×縮尺");
    if (bv.conflict || cv.conflict) notes.push("図面内の寸法段で値が食い違っています（要確認）");
    rows.push(
      row(
        check,
        dir,
        p.b.name + "〜" + q.b.name,
        U.fmtMm(bv.value),
        U.fmtMm(cv.value),
        diff,
        Math.abs(diff) <= tol ? "OK" : "NG",
        notes.join(" / "),
        { b: [p.b.ax, q.b.ax], c: [p.c.ax, q.c.ax] }
      )
    );
  }

  function partsNote(annot) {
    return annot.parts && annot.parts.length > 1 ? "（" + annot.parts.join("+") + "）" : "";
  }

  function prep(axes, mmPerPt) {
    const sorted = (axes || []).slice().sort((p, q) => p.pos - q.pos);
    return sorted.map((ax) => ({
      ax,
      label: ax.label != null ? ax.label : null,
      // UI の一覧と同じ表示名（検出時の連番）を使う
      name: nameOf(ax),
      mm: ax.pos * mmPerPt,
    }));
  }

  function nameOf(ax) {
    return ax.label != null ? ax.label : ZC.axis.displayName(ax);
  }

  // 符号一致を優先し、残りは位置（オフセット補正後）で対応付ける
  function matchAxes(bList, cList) {
    const matches = [];
    const usedC = new Set();
    const byLabel = new Map();
    for (const c of cList) {
      if (c.label != null && !byLabel.has(c.label)) byLabel.set(c.label, c);
    }
    const bRest = [];
    for (const b of bList) {
      const c = b.label != null ? byLabel.get(b.label) : undefined;
      if (c && !usedC.has(c)) {
        matches.push({ b, c });
        usedC.add(c);
      } else {
        bRest.push(b);
      }
    }
    let offset = 0;
    if (matches.length) {
      offset = U.median(matches.map((m) => m.c.mm - m.b.mm));
    } else if (bList.length && cList.length) {
      offset = cList[0].mm - bList[0].mm;
    }
    const cRest = cList.filter((c) => !usedC.has(c));
    for (const b of bRest) {
      let best = null;
      let bestD = PARAMS.MATCH_TOL_MM;
      for (const c of cRest) {
        if (usedC.has(c)) continue;
        const d = Math.abs(c.mm - (b.mm + offset));
        if (d <= bestD) {
          bestD = d;
          best = c;
        }
      }
      if (best) {
        matches.push({ b, c: best });
        usedC.add(best);
      }
    }
    matches.sort((p, q) => p.b.mm - q.b.mm);
    const bOnly = bList.filter((b) => !matches.some((m) => m.b === b));
    const cOnly = cList.filter((c) => !usedC.has(c));
    return { matches, bOnly, cOnly };
  }

  function row(check, dir, item, baseVal, cmpVal, diffMm, status, note, refs) {
    const r = {
      check,
      dir: DIR_NAME[dir] || dir,
      item,
      base: baseVal,
      cmp: cmpVal,
      diff: diffMm == null ? null : diffMm,
      status,
      note: note || "",
    };
    if (refs) {
      // UI がビュワー強調に使う芯オブジェクト参照。列挙不可にして JSON/CSV には出さない
      Object.defineProperty(r, "refs", { value: refs, enumerable: false });
    }
    return r;
  }

  ZC.compare = { compare, matchAxes, PARAMS };
})(globalThis.ZC = globalThis.ZC || {});
