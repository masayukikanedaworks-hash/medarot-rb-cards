// AI解析（任意機能）: PDFをサーバ関数 /api/analyze に送り、Claude に通り芯と寸法を
// 総ざらいさせて、自動読み取り（このツールのパーサ）の結果と突き合わせる。
//
// 注意: この機能を使うときだけ図面PDFが外部（Anthropic API）に送信される。
// 使わなければ従来どおりブラウザ内で完結する。
(function (ZC) {
  "use strict";

  const ENDPOINT = "/api/analyze";
  const SIDE_ORDER = ["top", "right", "bottom", "left"];
  const SIDE_NAME = { top: "上辺", right: "右辺", bottom: "下辺", left: "左辺" };

  // Uint8Array → base64（大きなPDFでもスタックを溢れさせないよう分割する）
  function toBase64(bytes) {
    const CHUNK = 0x8000;
    let bin = "";
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  async function analyze(pdfBytes, page) {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pdfBase64: toBase64(pdfBytes), page: page || 1 }),
    });
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }
    if (!res.ok) {
      const msg = data && data.error ? data.error : "AI解析に失敗しました（" + res.status + "）";
      throw new Error(msg);
    }
    return data;
  }

  function num(v) {
    return typeof v === "number" && isFinite(v) ? v : null;
  }

  // AIの応答を辺→{axes, spans} の形に正規化する（欠けている辺は空で埋める）
  function normalize(result) {
    const src = (result && result.sides) || {};
    const out = {};
    for (const key of SIDE_ORDER) {
      const s = src[key] || {};
      out[key] = {
        axes: Array.isArray(s.axes) ? s.axes.map((a) => ZC.util.normalizeLabel(String(a))) : [],
        spans: Array.isArray(s.spans)
          ? s.spans
              .filter((sp) => sp && sp.from != null && sp.to != null)
              .map((sp) => ({
                from: ZC.util.normalizeLabel(String(sp.from)),
                to: ZC.util.normalizeLabel(String(sp.to)),
                value: num(sp.value),
                parts: Array.isArray(sp.parts) ? sp.parts.map(num).filter((v) => v != null) : [],
              }))
          : [],
      };
    }
    return out;
  }

  // 自動読み取り（ZC.sides.build の結果）とAIの結果を突き合わせる
  // tol: 値の一致とみなす差(mm)
  function diff(localSides, aiSides, tol) {
    const t = tol > 0 ? tol : 1;
    const rows = [];
    const summary = { same: 0, differ: 0, localOnly: 0, aiOnly: 0 };
    const add = (side, kind, item, local, ai, status) => {
      rows.push({ side: SIDE_NAME[side], sideKey: side, kind, item, local, ai, status });
      if (status === "一致") summary.same++;
      else if (status === "相違") summary.differ++;
      else if (status === "自動のみ") summary.localOnly++;
      else summary.aiOnly++;
    };

    for (const key of SIDE_ORDER) {
      const L = (localSides && localSides[key]) || { axes: [], spans: [] };
      const A = (aiSides && aiSides[key]) || { axes: [], spans: [] };
      const lAxes = (L.axes || []).map((a) => (typeof a === "string" ? a : a.label));
      const aAxes = A.axes || [];

      // 通り芯の突き合わせ
      const lSet = new Set(lAxes);
      const aSet = new Set(aAxes);
      for (const label of lAxes) {
        if (!aSet.has(label)) add(key, "通り芯", label, "あり", "なし", "自動のみ");
      }
      for (const label of aAxes) {
        if (!lSet.has(label)) add(key, "通り芯", label, "なし", "あり", "AIのみ");
      }
      if (lAxes.length && aAxes.length && lAxes.join(",") === aAxes.join(",")) {
        add(key, "通り芯", "全" + lAxes.length + "本", lAxes.join(" "), "同じ並び", "一致");
      }

      // 寸法の突き合わせ（区間 from~to をキーにする）
      const aByKey = new Map(A.spans.map((s) => [s.from + "~" + s.to, s]));
      const seen = new Set();
      for (const ls of L.spans || []) {
        const k = ls.from + "~" + ls.to;
        seen.add(k);
        const as = aByKey.get(k);
        const lv = num(ls.value);
        const av = as ? num(as.value) : null;
        if (!as) {
          add(key, "寸法", k, fmt(lv), "—", "自動のみ");
        } else if (lv == null && av == null) {
          add(key, "寸法", k, "記載なし", "記載なし", "一致");
        } else if (lv == null || av == null) {
          add(key, "寸法", k, fmt(lv), fmt(av), "相違");
        } else {
          add(key, "寸法", k, fmt(lv), fmt(av), Math.abs(lv - av) <= t ? "一致" : "相違");
        }
      }
      for (const as of A.spans || []) {
        const k = as.from + "~" + as.to;
        if (seen.has(k)) continue;
        add(key, "寸法", k, "—", fmt(num(as.value)), "AIのみ");
      }
    }
    return { rows, summary };
  }

  function fmt(v) {
    return v == null ? "記載なし" : ZC.sides.fmtVal(v);
  }

  // AIの結果を拾い出し表記のテキストにする
  function formatText(aiSides) {
    const lines = [];
    for (const key of SIDE_ORDER) {
      const s = aiSides[key] || { axes: [], spans: [] };
      lines.push(SIDE_NAME[key]);
      if (!s.spans.length) {
        lines.push(s.axes.length ? "  " + s.axes.join(" ") + "（区間なし）" : "  （通り芯なし）");
      } else {
        for (const sp of s.spans) {
          const parts = sp.parts && sp.parts.length > 1 ? "（" + sp.parts.map(ZC.sides.fmtVal).join("+") + "）" : "";
          lines.push(sp.from + "~" + sp.to + "：" + (sp.value == null ? "記載なし" : ZC.sides.fmtVal(sp.value)) + parts);
        }
      }
      lines.push("");
    }
    return lines.join("\n").trim();
  }

  ZC.ai = { analyze, normalize, diff, formatText, toBase64, SIDE_ORDER, SIDE_NAME, ENDPOINT };
})(globalThis.ZC = globalThis.ZC || {});
