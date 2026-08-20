// 辺別の拾い出し: 上辺・下辺・左辺・右辺それぞれについて、
// その辺に符号バブルがある通り芯を並べ、その辺の寸法線から芯間寸法を読む。
(function (ZC) {
  "use strict";

  const SIDES = ZC.axis.SIDES;
  const SIDE_NAME = ZC.axis.SIDE_NAME;

  // 通り芯の端からこの範囲にある寸法段だけを「その辺の通り芯寸法」として使う(pt)。
  // 室内寸法など図面内部の寸法段を拾わないための帯。芯の長さが場所で変わる図面
  // （平面が2区画に分かれている等）に対応するため、区間ごとにその2本の芯の端で判定する。
  const SIDE_BAND = 72;

  // 表示用の数値整形（整数はそのまま、小数は必要な桁だけ）
  function fmtVal(v) {
    if (v == null || !isFinite(v)) return "—";
    const r = Math.round(v * 1000) / 1000;
    return Number.isInteger(r) ? String(r) : String(r);
  }

  // det: ZC.axis.detect の結果 / entries: ZC.dims.extract().entries
  // opts.enabled: 照合対象の芯の Set（省略時は defaultOn の芯）
  function build(det, entries, opts) {
    const enabled = opts && opts.enabled;
    const isOn = (ax) => (enabled ? enabled.has(ax) : ax.defaultOn);
    const pick = (list) => list.filter((ax) => ax.label != null && isOn(ax));
    const vAxes = pick(det.v || []);
    const hAxes = pick(det.h || []);
    const out = {};
    for (const side of SIDES) {
      const dir = side === "top" || side === "bottom" ? "v" : "h";
      const axes = (dir === "v" ? vAxes : hAxes)
        .filter((ax) => ax.bubbles.some((b) => b.side === side))
        .sort((a, b) => a.pos - b.pos);
      const dirEntries = (entries || []).filter((e) => e.dir === dir);
      const outward = side === "top" || side === "right";
      // その辺の符号バブルの位置（= その辺がどこにあるか）を返す
      const bubblePos = (ax) => {
        const b = ax.bubbles.find((x) => x.side === side);
        if (!b) return null;
        return dir === "v" ? b.y : b.x;
      };
      // その2本の芯の「その辺の端」の近くにある寸法段だけを使う。
      // 辺の位置は2本の符号バブルのうち内側（2本とも芯が伸びている側）を基準にする。
      // L字平面など芯の長さが場所で変わる図面や、一部にしか引かれていない短い芯
      // （X3 など）でも、その辺の寸法段だけが帯に入る。
      const nearAxes = (a, b) => {
        const pa = bubblePos(a);
        const pb = bubblePos(b);
        const edge =
          pa != null && pb != null
            ? outward ? Math.min(pa, pb) : Math.max(pa, pb)
            : outward ? Math.max(a.to, b.to) : Math.min(a.from, b.from);
        return dirEntries.filter((e) => Math.abs(e.row - edge) <= SIDE_BAND);
      };
      const spans = [];
      for (let i = 0; i + 1 < axes.length; i++) {
        const a = axes[i];
        const b = axes[i + 1];
        const annot = ZC.dims.spanValue(nearAxes(a, b), dir, a.pos, b.pos);
        spans.push({
          from: a.label,
          to: b.label,
          fromAx: a,
          toAx: b,
          value: annot ? annot.value : null,
          parts: annot ? annot.parts : null,
          conflict: annot ? annot.conflict : false,
        });
      }
      let total = null;
      if (axes.length >= 2) {
        const t = ZC.dims.spanValue(
          nearAxes(axes[0], axes[axes.length - 1]),
          dir,
          axes[0].pos,
          axes[axes.length - 1].pos
        );
        total = t
          ? { from: axes[0].label, to: axes[axes.length - 1].label, value: t.value, parts: t.parts }
          : { from: axes[0].label, to: axes[axes.length - 1].label, value: null, parts: null };
      }
      out[side] = { side, name: SIDE_NAME[side], dir, axes, spans, total, entryCount: dirEntries.length };
    }
    return out;
  }

  // 1区間の表記: 「X1~X2：5917（2730.5+3186.5）」
  function formatSpan(sp) {
    const val = sp.value == null ? "記載なし" : fmtVal(sp.value);
    const parts = sp.parts && sp.parts.length > 1 ? "（" + sp.parts.map(fmtVal).join("+") + "）" : "";
    return sp.from + "~" + sp.to + "：" + val + parts + (sp.conflict ? " ※寸法段で食い違い" : "");
  }

  // 拾い出し結果をテキストにする
  // （X方向: 上辺→下辺 / Y方向: 右辺→左辺。画面の並びと同じ）
  const DIR_GROUPS = [
    { title: "X方向", sides: ["top", "bottom"] },
    { title: "Y方向", sides: ["right", "left"] },
  ];

  function formatText(sides) {
    const lines = [];
    for (const g of DIR_GROUPS) {
      lines.push("■" + g.title);
      for (const key of g.sides) {
        const s = sides[key];
        if (!s) continue;
        lines.push(s.name);
        if (!s.axes.length) {
          lines.push("  （通り芯なし）");
        } else if (!s.spans.length) {
          lines.push("  " + s.axes.map((a) => a.label).join(" ") + "（区間なし）");
        } else {
          for (const sp of s.spans) lines.push(formatSpan(sp));
        }
        lines.push("");
      }
    }
    return lines.join("\n").trim();
  }

  ZC.sides = { build, formatSpan, formatText, fmtVal, SIDES, SIDE_NAME };
})(globalThis.ZC = globalThis.ZC || {});
