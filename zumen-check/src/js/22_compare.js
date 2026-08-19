// 照合: 基準図面と比較図面の通り芯を対応付け、符号・芯々寸法・全体寸法の差異を洗い出す
(function (ZC) {
  "use strict";

  const U = ZC.util;

  const PARAMS = {
    MATCH_TOL_MM: 25, // 位置による対応付けの最大ずれ(mm)
  };

  const DIR_NAME = { v: "縦(X方向の並び)", h: "横(Y方向の並び)" };

  // side: {v:[axes], h:[axes], mmPerPt, dimSamples, name}
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
            rows.push(row("符号", dir, m.b.name + " ↔ " + m.c.name, m.b.label, m.c.label, null, "NG", "符号が一致しません"));
            ngCount++;
          }
        }
        for (const b of bOnly) {
          rows.push(row("符号", dir, b.name, "あり", "なし", null, b.label != null ? "NG" : "WARN", "比較図面に対応する芯がありません"));
          ngCount++;
        }
        for (const c of cOnly) {
          rows.push(row("符号", dir, c.name, "なし", "あり", null, c.label != null ? "NG" : "WARN", "基準図面に対応する芯がありません"));
          ngCount++;
        }
        if (!ngCount && matches.length) {
          rows.push(
            row("符号", dir, "全" + matches.length + "本", matches.map((m) => m.b.name).join(" "), "対応あり", null, "OK", "")
          );
        }
      }

      if (checks.spacing !== false) {
        for (let i = 0; i + 1 < matches.length; i++) {
          const p = matches[i];
          const q = matches[i + 1];
          const dB = q.b.mm - p.b.mm;
          const dC = q.c.mm - p.c.mm;
          const diff = dC - dB;
          rows.push(
            row(
              "芯々寸法",
              dir,
              p.b.name + "〜" + q.b.name,
              U.fmtMm(dB),
              U.fmtMm(dC),
              diff,
              Math.abs(diff) <= tol ? "OK" : "NG",
              ""
            )
          );
        }
      }

      if (checks.total !== false && matches.length >= 2) {
        const p = matches[0];
        const q = matches[matches.length - 1];
        const dB = q.b.mm - p.b.mm;
        const dC = q.c.mm - p.c.mm;
        const diff = dC - dB;
        rows.push(
          row(
            "全体寸法",
            dir,
            p.b.name + "〜" + q.b.name,
            U.fmtMm(dB),
            U.fmtMm(dC),
            diff,
            Math.abs(diff) <= tol ? "OK" : "NG",
            ""
          )
        );
      }
    }

    // 図面内の寸法注記と作図位置の食い違い（各図面ごと）
    if (checks.dims) {
      for (const side of [base, cmp]) {
        for (const s of side.dimSamples || []) {
          const geomMm = s.gapPt * side.mmPerPt;
          const diff = geomMm - s.value;
          rows.push(
            row(
              "寸法値整合(" + side.name + ")",
              s.dir,
              nameOf(s.a) + "〜" + nameOf(s.b),
              U.fmtMm(s.value, 0),
              U.fmtMm(geomMm),
              diff,
              Math.abs(diff) <= tol ? "OK" : "NG",
              "注記寸法と作図上の芯々距離の比較"
            )
          );
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
    // 位置合わせ用オフセット: 符号一致ペアの中央値、なければ先頭同士
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

  function row(check, dir, item, baseVal, cmpVal, diffMm, status, note) {
    return {
      check,
      dir: DIR_NAME[dir] || dir,
      item,
      base: baseVal,
      cmp: cmpVal,
      diff: diffMm == null ? null : diffMm,
      status,
      note: note || "",
    };
  }

  ZC.compare = { compare, matchAxes, PARAMS };
})(globalThis.ZC = globalThis.ZC || {});
