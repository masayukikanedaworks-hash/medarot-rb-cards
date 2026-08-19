// UI 層: ファイル読み込み・プレビュー描画・芯リスト・照合結果表示
// DOM を触るのはこのファイルと 31_app.js のみ（テストは 2x系までのロジックを対象とする）
(function (ZC) {
  "use strict";

  const U = ZC.util;

  const COLORS = {
    seg: "#b9c0c7",
    v: "#1565d8",
    h: "#0a8f4e",
    off: "#c7c7c7",
    hover: "#f5820a",
  };

  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        if (k === "class") e.className = attrs[k];
        else if (k === "text") e.textContent = attrs[k];
        else if (k.startsWith("on")) e.addEventListener(k.slice(2), attrs[k]);
        else e.setAttribute(k, attrs[k]);
      }
    }
    for (const c of children || []) e.appendChild(c);
    return e;
  }

  class Panel {
    constructor(key, title, container) {
      this.key = key;
      this.title = title;
      this.root = container;
      this.doc = null;
      this.pages = [];
      this.extract = null;
      this.axes = { v: [], h: [] };
      this.enabled = new Set();
      this.hoverAx = null;
      this.fileName = "";
      this._build();
    }

    _build() {
      this.root.innerHTML =
        '<div class="file-row">' +
        '<label class="file-btn">PDFを選択<input type="file" accept=".pdf,application/pdf" hidden></label>' +
        '<span class="fname">未選択</span>' +
        "</div>" +
        '<div class="ctrl-row">' +
        '<label>ページ <select class="page-sel" disabled></select></label>' +
        '<label>縮尺 1/<input class="scale-in" type="number" value="100" min="1" step="any"></label>' +
        '<span class="scale-note"></span>' +
        "</div>" +
        '<div class="status"></div>' +
        '<canvas class="preview"></canvas>' +
        '<div class="axis-list"></div>';
      this.$file = this.root.querySelector('input[type="file"]');
      this.$fname = this.root.querySelector(".fname");
      this.$page = this.root.querySelector(".page-sel");
      this.$scale = this.root.querySelector(".scale-in");
      this.$scaleNote = this.root.querySelector(".scale-note");
      this.$status = this.root.querySelector(".status");
      this.$canvas = this.root.querySelector("canvas");
      this.$list = this.root.querySelector(".axis-list");
      this.$file.addEventListener("change", () => this._onFile());
      this.$page.addEventListener("change", () => this.loadPage(Number(this.$page.value)));
    }

    setStatus(msg, kind) {
      this.$status.textContent = msg || "";
      this.$status.className = "status" + (kind ? " " + kind : "");
    }

    async _onFile() {
      const f = this.$file.files && this.$file.files[0];
      if (!f) return;
      this.fileName = f.name;
      this.$fname.textContent = f.name;
      this.setStatus("読み込み中…");
      this.doc = null;
      this.pages = [];
      this.extract = null;
      this.axes = { v: [], h: [] };
      this.enabled.clear();
      try {
        const buf = new Uint8Array(await f.arrayBuffer());
        this.doc = await ZC.pdf.PDFDocument.load(buf);
        this.pages = await this.doc.getPages();
        this.$page.innerHTML = "";
        this.pages.forEach((_, i) => {
          this.$page.appendChild(el("option", { value: String(i), text: String(i + 1) + " / " + this.pages.length }));
        });
        this.$page.disabled = this.pages.length <= 1;
        await this.loadPage(0);
      } catch (e) {
        this.doc = null;
        this.setStatus("読み込みに失敗しました: " + (e && e.message ? e.message : e), "error");
        this.renderCanvas();
        this.renderList();
        ZC.ui.updateRunButton();
      }
    }

    async loadPage(index) {
      if (!this.doc || !this.pages[index]) return;
      this.setStatus("解析中…");
      try {
        const ex = new ZC.content.ContentExtractor(this.doc);
        this.extract = await ex.run(this.pages[index]);
        const det = ZC.axis.detect(this.extract);
        this.axes = { v: det.v, h: det.h };
        this.enabled.clear();
        for (const ax of det.v.concat(det.h)) {
          if (ax.defaultOn) this.enabled.add(ax);
        }
        // 縮尺の自動推定（既定ONの芯のみを対象）
        const onV = det.v.filter((a) => this.enabled.has(a));
        const onH = det.h.filter((a) => this.enabled.has(a));
        const samples = ZC.scale.collectDimSamples(onV, onH, this.extract.texts);
        const inf = ZC.scale.infer(samples);
        if (inf.den != null) {
          const den = inf.snapped ? inf.den : Math.round(inf.den * 10) / 10;
          this.$scale.value = String(den);
          this.$scaleNote.textContent = "自動推定 1/" + den + "（寸法値" + inf.count + "件より）";
        } else {
          this.$scaleNote.textContent = "縮尺を推定できません。手入力してください。";
        }
        const nSeg = this.extract.segments.length;
        if (nSeg === 0) {
          this.setStatus(
            this.extract.imageCount > 0
              ? "線分を抽出できませんでした。スキャン（ラスタ）PDFの可能性があります。"
              : "線分を抽出できませんでした。",
            "error"
          );
        } else {
          const on = this.enabled.size;
          this.setStatus(
            "通り芯候補: 縦" + det.v.length + "本 / 横" + det.h.length + "本（うち" + on + "本をチェック済み）。誤検出はチェックを外してください。"
          );
        }
      } catch (e) {
        this.extract = null;
        this.axes = { v: [], h: [] };
        this.setStatus("解析に失敗しました: " + (e && e.message ? e.message : e), "error");
      }
      this.renderCanvas();
      this.renderList();
      ZC.ui.updateRunButton();
    }

    allAxes() {
      return this.axes.v.concat(this.axes.h);
    }

    enabledAxes() {
      return {
        v: this.axes.v.filter((a) => this.enabled.has(a)),
        h: this.axes.h.filter((a) => this.enabled.has(a)),
      };
    }

    mmPerPt() {
      const den = Number(this.$scale.value);
      return den > 0 ? ZC.scale.mmPerPtFromDen(den) : null;
    }

    ready() {
      return !!(this.extract && (this.enabled.size >= 1) && this.mmPerPt());
    }

    renderCanvas() {
      const cv = this.$canvas;
      const cssW = cv.clientWidth || 600;
      const cssH = 380;
      const dpr = (globalThis.devicePixelRatio || 1);
      cv.width = Math.round(cssW * dpr);
      cv.height = Math.round(cssH * dpr);
      const ctx = cv.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, cssW, cssH);
      if (!this.extract || !this.extract.segments.length) {
        ctx.fillStyle = "#8a939b";
        ctx.font = "13px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(this.doc ? "表示できる線分がありません" : "PDFを読み込むとここにプレビューが表示されます", cssW / 2, cssH / 2);
        return;
      }
      const pw = this.extract.width;
      const ph = this.extract.height;
      const pad = 8;
      const sc = Math.min((cssW - pad * 2) / pw, (cssH - pad * 2) / ph);
      const ox = (cssW - pw * sc) / 2;
      const oy = (cssH - ph * sc) / 2;
      const X = (x) => ox + x * sc;
      const Y = (y) => oy + (ph - y) * sc; // PDFはy上向き

      // 全線分（下地）
      ctx.lineWidth = 0.6;
      ctx.strokeStyle = COLORS.seg;
      ctx.beginPath();
      const segs = this.extract.segments;
      const maxDraw = 150000;
      for (let i = 0; i < segs.length && i < maxDraw; i++) {
        const s = segs[i];
        ctx.moveTo(X(s.x1), Y(s.y1));
        ctx.lineTo(X(s.x2), Y(s.y2));
      }
      ctx.stroke();

      // 通り芯の重ね描き
      for (const ax of this.allAxes()) {
        const on = this.enabled.has(ax);
        const hover = this.hoverAx === ax;
        ctx.lineWidth = hover ? 2.5 : on ? 1.6 : 1;
        ctx.strokeStyle = hover ? COLORS.hover : !on ? COLORS.off : ax.dir === "v" ? COLORS.v : COLORS.h;
        ctx.setLineDash(on || hover ? [7, 3, 2, 3] : [2, 3]);
        ctx.beginPath();
        if (ax.dir === "v") {
          ctx.moveTo(X(ax.pos), Y(ax.from));
          ctx.lineTo(X(ax.pos), Y(ax.to));
        } else {
          ctx.moveTo(X(ax.from), Y(ax.pos));
          ctx.lineTo(X(ax.to), Y(ax.pos));
        }
        ctx.stroke();
        ctx.setLineDash([]);
        if (on || hover) {
          const name = ZC.axis.displayName(ax);
          ctx.fillStyle = hover ? COLORS.hover : ax.dir === "v" ? COLORS.v : COLORS.h;
          ctx.font = "bold 11px sans-serif";
          ctx.textAlign = "center";
          if (ax.dir === "v") ctx.fillText(name, X(ax.pos), Y(ax.to) - 4);
          else {
            ctx.textAlign = "right";
            ctx.fillText(name, X(ax.from) - 4, Y(ax.pos) + 4);
          }
        }
      }
    }

    renderList() {
      this.$list.innerHTML = "";
      const axes = this.allAxes();
      if (!axes.length) return;
      const table = el("table", { class: "axes" });
      const thead = el("thead");
      thead.innerHTML =
        "<tr><th>照合</th><th>方向</th><th>符号</th><th>位置(mm)</th><th>長さ(mm)</th><th>線種</th></tr>";
      table.appendChild(thead);
      const tbody = el("tbody");
      const mmPerPt = this.mmPerPt() || 0;
      const list = this.axes.v.concat(this.axes.h);
      for (const ax of list) {
        const tr = el("tr", {
          class: this.enabled.has(ax) ? "" : "off",
          onmouseenter: () => {
            this.hoverAx = ax;
            this.renderCanvas();
          },
          onmouseleave: () => {
            this.hoverAx = null;
            this.renderCanvas();
          },
        });
        const cb = el("input", { type: "checkbox" });
        cb.checked = this.enabled.has(ax);
        cb.addEventListener("change", () => {
          if (cb.checked) this.enabled.add(ax);
          else this.enabled.delete(ax);
          tr.className = cb.checked ? "" : "off";
          this.renderCanvas();
          ZC.ui.updateRunButton();
        });
        tr.appendChild(el("td", {}, [cb]));
        tr.appendChild(el("td", { text: ax.dir === "v" ? "縦" : "横" }));
        tr.appendChild(el("td", { text: ZC.axis.displayName(ax) + (ax.label == null ? "（符号なし）" : "") }));
        tr.appendChild(el("td", { text: mmPerPt ? U.fmtMm(ax.pos * mmPerPt, 0) : "—" }));
        tr.appendChild(el("td", { text: mmPerPt ? U.fmtMm(ax.extent * mmPerPt, 0) : "—" }));
        tr.appendChild(
          el("td", {
            text: (ax.dashed ? "鎖線/破線" : "実線") + (ax.frameSuspect ? "・図枠?" : ""),
          })
        );
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      this.$list.appendChild(table);
    }
  }

  const ui = {
    base: null,
    cmp: null,
    lastResult: null,

    init() {
      document.querySelectorAll(".ver").forEach((e) => (e.textContent = "v" + ZC.VERSION));
      ui.base = new Panel("base", "基準図面", document.getElementById("panel-base-body"));
      ui.cmp = new Panel("cmp", "比較図面", document.getElementById("panel-cmp-body"));
      document.getElementById("run-check").addEventListener("click", () => ui.runCheck());
      document.getElementById("csv-dl").addEventListener("click", () => ui.downloadCsv());
      globalThis.addEventListener("resize", () => {
        ui.base.renderCanvas();
        ui.cmp.renderCanvas();
      });
      ui.updateRunButton();
    },

    updateRunButton() {
      const btn = document.getElementById("run-check");
      if (btn) btn.disabled = !(ui.base && ui.cmp && ui.base.ready() && ui.cmp.ready());
    },

    gatherSide(panel, name) {
      const en = panel.enabledAxes();
      const mmPerPt = panel.mmPerPt();
      return {
        v: en.v,
        h: en.h,
        mmPerPt,
        dimSamples: ZC.scale.collectDimSamples(en.v, en.h, panel.extract.texts),
        name,
      };
    },

    runCheck() {
      const tol = Number(document.getElementById("tol").value) || 1;
      const checks = {
        labels: document.getElementById("ck-labels").checked,
        spacing: document.getElementById("ck-spacing").checked,
        total: document.getElementById("ck-total").checked,
        dims: document.getElementById("ck-dims").checked,
      };
      const base = ui.gatherSide(ui.base, "基準");
      const cmp = ui.gatherSide(ui.cmp, "比較");
      const result = ZC.compare.compare(base, cmp, { tol, checks });
      ui.lastResult = result;
      ui.renderResult(result, tol);
    },

    renderResult(result, tol) {
      const wrap = document.getElementById("result");
      wrap.innerHTML = "";
      const s = result.summary;
      const sumCls = s.ng ? "ng" : s.warn ? "warn" : "ok";
      wrap.appendChild(
        el("div", {
          class: "summary " + sumCls,
          text:
            (s.ng ? "NG " + s.ng + "件" : "NGなし") +
            (s.warn ? " / 要確認 " + s.warn + "件" : "") +
            " / OK " + s.ok + "件" +
            "（許容差 ±" + tol + "mm）",
        })
      );
      if (!result.rows.length) {
        wrap.appendChild(el("p", { text: "チェック項目が選択されていないか、対応する芯がありません。" }));
        document.getElementById("csv-dl").hidden = true;
        return;
      }
      const table = el("table", { class: "result" });
      const thead = el("thead");
      thead.innerHTML =
        "<tr><th>判定</th><th>チェック</th><th>方向</th><th>対象</th><th>基準</th><th>比較</th><th>差(mm)</th><th>備考</th></tr>";
      table.appendChild(thead);
      const tbody = el("tbody");
      for (const r of result.rows) {
        const tr = el("tr", { class: r.status.toLowerCase() });
        tr.appendChild(el("td", { text: r.status === "WARN" ? "要確認" : r.status, class: "st" }));
        tr.appendChild(el("td", { text: r.check }));
        tr.appendChild(el("td", { text: r.dir }));
        tr.appendChild(el("td", { text: r.item }));
        tr.appendChild(el("td", { text: String(r.base) }));
        tr.appendChild(el("td", { text: String(r.cmp) }));
        tr.appendChild(el("td", { text: r.diff == null ? "—" : (r.diff > 0 ? "+" : "") + U.fmtMm(r.diff) }));
        tr.appendChild(el("td", { text: r.note }));
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      wrap.appendChild(table);
      document.getElementById("csv-dl").hidden = false;
    },

    downloadCsv() {
      if (!ui.lastResult) return;
      const head = ["判定", "チェック", "方向", "対象", "基準", "比較", "差(mm)", "備考"];
      const lines = [head.join(",")];
      for (const r of ui.lastResult.rows) {
        const cells = [
          r.status,
          r.check,
          r.dir,
          r.item,
          String(r.base),
          String(r.cmp),
          r.diff == null ? "" : U.fmtMm(r.diff),
          r.note,
        ].map((c) => '"' + String(c).replace(/"/g, '""') + '"');
        lines.push(cells.join(","));
      }
      // Excel で文字化けしないよう BOM 付き UTF-8
      const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "zumen-check.csv";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    },
  };

  ZC.ui = ui;
})(globalThis.ZC = globalThis.ZC || {});
