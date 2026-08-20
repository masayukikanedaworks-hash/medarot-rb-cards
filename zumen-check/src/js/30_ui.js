// UI 層: ファイル読み込み・対話ビュワー（ズーム/パン/測定）・辺別の拾い出し・照合結果表示
// DOM を触るのはこのファイルと 31_app.js のみ（テストは 2x系までのロジックを対象とする）
(function (ZC) {
  "use strict";

  const SIDE_ORDER = ["top", "right", "bottom", "left"];

  const COLORS = {
    seg: "#b9c0c7",
    v: "#1565d8",
    h: "#0a8f4e",
    off: "#c7c7c7",
    hover: "#f5820a",
    dim: "#a15c00",
    measure: "#d81b60",
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

  // 拾い出し結果を「X方向（上辺・下辺）」「Y方向（右辺・左辺）」の2ブロックに分け、
  // 各方向の中で2辺を横並びにする。各辺は「区間 ： 値 （内訳）」の表で、
  // 値は右揃えにして桁を揃える。
  // sidesLike: {top:{axes,spans}, right:…, bottom:…, left:…}（拾い出し結果・AI結果の両方に使う）
  const DIR_GROUPS = [
    { title: "X方向（縦方向の通り芯）", sides: ["top", "bottom"] },
    { title: "Y方向（横方向の通り芯）", sides: ["right", "left"] },
  ];

  function sideBlock(key, side) {
    const block = el("div", { class: "side-block" });
    block.appendChild(el("div", { class: "side-title", text: ZC.axis.SIDE_NAME[key] }));
    const spans = side.spans || [];
    if (!spans.length) {
      const axes = (side.axes || []).map((a) => (typeof a === "string" ? a : a.label));
      block.appendChild(
        el("div", { class: "side-empty", text: axes.length ? axes.join(" ") + "（区間なし）" : "（通り芯なし）" })
      );
      return block;
    }
    const table = el("table", { class: "span-table" });
    const tbody = el("tbody");
    for (const sp of spans) {
      const tr = el("tr", { class: sp.conflict ? "conflict" : "" });
      tr.appendChild(el("td", { class: "k", text: sp.from + "~" + sp.to }));
      tr.appendChild(el("td", { class: "c", text: "：" }));
      tr.appendChild(
        el("td", {
          class: "v" + (sp.value == null ? " none" : ""),
          text: sp.value == null ? "記載なし" : ZC.sides.fmtVal(sp.value),
        })
      );
      tr.appendChild(
        el("td", {
          class: "p",
          text: sp.parts && sp.parts.length > 1 ? "（" + sp.parts.map(ZC.sides.fmtVal).join("+") + "）" : "",
          title: sp.conflict ? "図面内の寸法段で値が食い違っています" : "",
        })
      );
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    block.appendChild(table);
    return block;
  }

  function renderSideBlocks(container, sidesLike) {
    container.innerHTML = "";
    if (!sidesLike) return;
    for (const g of DIR_GROUPS) {
      const group = el("div", { class: "dir-group" });
      group.appendChild(el("div", { class: "dir-title", text: g.title }));
      const cols = el("div", { class: "dir-cols" });
      for (const key of g.sides) cols.appendChild(sideBlock(key, sidesLike[key] || { axes: [], spans: [] }));
      group.appendChild(cols);
      container.appendChild(group);
    }
  }

  // 白フチ付き文字（図面の上でも読めるように）
  function haloText(ctx, str, x, y) {
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255,255,255,.9)";
    ctx.strokeText(str, x, y);
    ctx.fillText(str, x, y);
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
      this.det = { v: [], h: [] };
      this.dimsInfo = { dots: [], entries: [] };
      this.sides = null;
      this.enabled = new Set();
      this.fileName = "";
      this.pdfBytes = null; // AI解析に送るPDFの実体
      this.aiSides = null;
      // ビュワー状態
      this.view = null; // {scale, ox, oy, fitScale}
      this.autoHeightPx = null; // ビュワー高さの自動調整値
      this.userSizedViewer = false; // 利用者が高さを変えたか
      this.showDims = true;
      this.measuring = false;
      this.measure = null;
      this.measureTemp = null;
      this._measureCursor = null;
      this.hoverAx = null;
      this.highlightAxes = null;
      this._rowMap = new Map();
      this._drag = null;
      this._raf = 0;
      this._build();
    }

    _build() {
      this.root.innerHTML =
        '<div class="file-row">' +
        '<label class="file-btn">PDFを選択<input type="file" accept=".pdf,application/pdf" hidden></label>' +
        '<span class="fname">未選択</span>' +
        "</div>" +
        '<div class="ctrl-row"><label>ページ <select class="page-sel" disabled></select></label></div>' +
        '<div class="status"></div>' +
        '<div class="viewer-bar">' +
        '<button type="button" class="vb-fit" title="全体表示（ダブルクリックでも可）">フィット</button>' +
        '<button type="button" class="vb-measure" title="2点間の距離を測る（芯・端点にスナップ / Escで解除）">測定</button>' +
        '<label title="辺ごとの記載寸法を図上に表示"><input type="checkbox" class="vb-dims" checked> 寸法表示</label>' +
        '<span class="zoom-label">—</span>' +
        '<span class="viewer-hint">ホイール:拡大縮小 / ドラッグ:移動 / 芯クリック:拾い出しON/OFF</span>' +
        "</div>" +
        '<div class="viewer-wrap"><canvas class="preview"></canvas><div class="axtip"></div></div>' +
        '<div class="pickup"><div class="pickup-head">拾い出し結果<button type="button" class="copy-btn">コピー</button></div><div class="pickup-grid"></div></div>' +
        '<div class="ai-box">' +
        '<div class="ai-head">' +
        '<button type="button" class="ai-run" disabled title="この図面PDFをAIに送り、通り芯と寸法を総ざらいさせます">AIで総ざらい</button>' +
        '<span class="ai-note">図面PDFが外部（Anthropic API）に送信されます</span>' +
        "</div>" +
        '<div class="ai-result"></div>' +
        "</div>" +
        '<div class="axis-list"></div>';
      this.$file = this.root.querySelector('input[type="file"]');
      this.$fname = this.root.querySelector(".fname");
      this.$page = this.root.querySelector(".page-sel");
      this.$status = this.root.querySelector(".status");
      this.$wrap = this.root.querySelector(".viewer-wrap");
      this.$canvas = this.root.querySelector("canvas");
      this.$tip = this.root.querySelector(".axtip");
      this.$list = this.root.querySelector(".axis-list");
      this.$pickup = this.root.querySelector(".pickup-grid");
      this.$copy = this.root.querySelector(".copy-btn");
      this.$aiRun = this.root.querySelector(".ai-run");
      this.$aiResult = this.root.querySelector(".ai-result");
      this.$zoom = this.root.querySelector(".zoom-label");
      this.$fit = this.root.querySelector(".vb-fit");
      this.$measureBtn = this.root.querySelector(".vb-measure");
      this.$dims = this.root.querySelector(".vb-dims");

      this.$file.addEventListener("change", () => this._onFile());
      this.$page.addEventListener("change", () => this.loadPage(Number(this.$page.value)));
      this.$fit.addEventListener("click", () => {
        this.fit();
        this.requestRender();
      });
      this.$measureBtn.addEventListener("click", () => this.setMeasuring(!this.measuring));
      this.$dims.addEventListener("change", () => {
        this.showDims = this.$dims.checked;
        this.requestRender();
      });
      this.$aiRun.addEventListener("click", () => this.runAi());
      this.$copy.addEventListener("click", () => {
        const txt = this.sides ? ZC.sides.formatText(this.sides) : "";
        if (navigator.clipboard) navigator.clipboard.writeText(txt);
        this.$copy.textContent = "コピーしました";
        setTimeout(() => (this.$copy.textContent = "コピー"), 1200);
      });

      const cv = this.$canvas;
      cv.addEventListener("wheel", (e) => this._onWheel(e), { passive: false });
      cv.addEventListener("mousedown", (e) => this._onDown(e));
      cv.addEventListener("mousemove", (e) => this._onMove(e));
      cv.addEventListener("mouseup", (e) => this._onUp(e));
      cv.addEventListener("mouseleave", () => {
        this._drag = null;
        this.hoverAx = null;
        this._measureCursor = null;
        this._tip(null);
        this.requestRender();
      });
      cv.addEventListener("dblclick", () => {
        this.fit();
        this.requestRender();
      });
      if (typeof ResizeObserver !== "undefined") {
        new ResizeObserver(() => {
          // 利用者が下端をドラッグして高さを変えたら、以後は自動調整しない
          const h = Math.round(this.$wrap.clientHeight);
          if (this.autoHeightPx != null && Math.abs(h - this.autoHeightPx) > 2) this.userSizedViewer = true;
          this.requestRender();
        }).observe(this.$wrap);
      }
    }

    setStatus(msg, kind) {
      this.$status.textContent = msg || "";
      this.$status.className = "status" + (kind ? " " + kind : "");
    }

    setMeasuring(on) {
      this.measuring = on;
      if (!on) this.measureTemp = null;
      this.$measureBtn.classList.toggle("active", on);
      this.$canvas.style.cursor = on ? "crosshair" : "grab";
      this.requestRender();
    }

    cancelMeasure() {
      if (!this.measuring && !this.measure) return;
      this.measure = null;
      this.measureTemp = null;
      this.setMeasuring(false);
    }

    async _onFile() {
      const f = this.$file.files && this.$file.files[0];
      if (!f) return;
      this.fileName = f.name;
      this.$fname.textContent = f.name;
      this.setStatus("読み込み中…");
      this._reset();
      try {
        const buf = new Uint8Array(await f.arrayBuffer());
        this.pdfBytes = buf;
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
        this.requestRender();
        this.renderList();
        this.renderPickup();
        ZC.ui.updateRunButton();
      }
    }

    _reset() {
      this.doc = null;
      this.pages = [];
      this.pdfBytes = null;
      this.aiSides = null;
      if (this.$aiResult) this.$aiResult.innerHTML = "";
      this.extract = null;
      this.axes = { v: [], h: [] };
      this.det = { v: [], h: [] };
      this.dimsInfo = { dots: [], entries: [] };
      this.sides = null;
      this.enabled.clear();
    }

    async loadPage(index) {
      if (!this.doc || !this.pages[index]) return;
      this.setStatus("解析中…");
      try {
        const ex = new ZC.content.ContentExtractor(this.doc);
        this.extract = await ex.run(this.pages[index]);
        const det = ZC.axis.detect(this.extract);
        this.det = det;
        this.axes = { v: det.v, h: det.h };
        this.enabled.clear();
        for (const ax of det.v.concat(det.h)) {
          if (ax.defaultOn) this.enabled.add(ax);
        }
        this.dimsInfo = ZC.dims.extract(this.extract);
        this.rebuildSides();
        const nSeg = this.extract.segments.length;
        if (nSeg === 0) {
          this.setStatus(
            this.extract.imageCount > 0
              ? "線分を抽出できませんでした。スキャン（ラスタ）PDFの可能性があります。"
              : "線分を抽出できませんでした。",
            "error"
          );
        } else {
          const labeled = det.v.concat(det.h).filter((a) => a.label != null).length;
          this.setStatus(
            "円で囲まれた符号の通り芯: " + labeled + "本" +
              "（縦" + det.v.filter((a) => a.label != null).length +
              " / 横" + det.h.filter((a) => a.label != null).length + "）" +
              " / 記載寸法 " + this.dimsInfo.entries.length + "区間を読取" +
              (this.extract.circles ? " / 符号バブル " + this.extract.circles.length + "個" : "")
          );
        }
      } catch (e) {
        this.extract = null;
        this.axes = { v: [], h: [] };
        this.det = { v: [], h: [] };
        this.dimsInfo = { dots: [], entries: [] };
        this.sides = null;
        this.setStatus("解析に失敗しました: " + (e && e.message ? e.message : e), "error");
      }
      this.autoHeight();
      this.view = null; // 高さが変わるので次の描画でフィットし直す
      this.requestRender();
      this.renderList();
      this.renderPickup();
      if (this.$aiRun) this.$aiRun.disabled = !this.pdfBytes;
      if (this.$aiResult) this.$aiResult.innerHTML = "";
      this.aiSides = null;
      ZC.ui.updateRunButton();
    }

    // AIに図面を読ませ、自動読み取りの結果と突き合わせる
    async runAi() {
      if (!this.pdfBytes) return;
      const page = Number(this.$page.value || 0) + 1;
      this.$aiRun.disabled = true;
      this.$aiRun.textContent = "AI解析中…";
      this.$aiResult.innerHTML = "";
      this.$aiResult.appendChild(el("p", { class: "ai-msg", text: "AIが図面を読んでいます（1〜2分かかることがあります）…" }));
      try {
        const data = await ZC.ai.analyze(this.pdfBytes, page);
        this.aiSides = ZC.ai.normalize(data.result);
        const tol = Number(document.getElementById("tol").value) || 1;
        this.renderAi(ZC.ai.diff(this.sides, this.aiSides, tol), data);
      } catch (e) {
        this.$aiResult.innerHTML = "";
        this.$aiResult.appendChild(
          el("p", { class: "ai-msg error", text: "AI解析に失敗しました: " + (e && e.message ? e.message : e) })
        );
      } finally {
        this.$aiRun.disabled = false;
        this.$aiRun.textContent = "AIで総ざらい";
      }
    }

    renderAi(diff, data) {
      const wrap = this.$aiResult;
      wrap.innerHTML = "";
      const s = diff.summary;
      wrap.appendChild(
        el("div", {
          class: "ai-summary" + (s.differ || s.aiOnly ? " warn" : ""),
          text:
            "一致 " + s.same + " / 相違 " + s.differ +
            " / 自動のみ " + s.localOnly + " / AIのみ " + s.aiOnly +
            (data && data.model ? "（" + data.model + "）" : ""),
        })
      );
      const notes = data && data.result && data.result.notes;
      if (notes) wrap.appendChild(el("p", { class: "ai-msg", text: "AIの注記: " + notes }));

      const rows = diff.rows.filter((r) => r.status !== "一致");
      if (!rows.length) {
        wrap.appendChild(el("p", { class: "ai-msg", text: "自動読み取りとAIの結果は一致しました。" }));
      } else {
        const table = el("table", { class: "ai-table" });
        const thead = el("thead");
        thead.innerHTML = "<tr><th>判定</th><th>辺</th><th>種別</th><th>対象</th><th>自動読み取り</th><th>AI</th></tr>";
        table.appendChild(thead);
        const tbody = el("tbody");
        for (const r of rows) {
          const tr = el("tr", { class: r.status === "相違" ? "differ" : "only" });
          tr.appendChild(el("td", { text: r.status, class: "st" }));
          tr.appendChild(el("td", { text: r.side }));
          tr.appendChild(el("td", { text: r.kind }));
          tr.appendChild(el("td", { text: r.item }));
          tr.appendChild(el("td", { text: String(r.local) }));
          tr.appendChild(el("td", { text: String(r.ai) }));
          tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        wrap.appendChild(table);
      }
      const det = el("details", { class: "ai-detail" });
      det.appendChild(el("summary", { text: "AIの拾い出し結果（全文）" }));
      const grid = el("div", { class: "pickup-grid" });
      renderSideBlocks(grid, this.aiSides);
      det.appendChild(grid);
      wrap.appendChild(det);
    }

    rebuildSides() {
      this.sides = ZC.sides.build(this.det, this.dimsInfo.entries, { enabled: this.enabled });
    }

    // 符号付きの芯だけを一覧・照合の対象にする
    labeledAxes() {
      return this.axes.v.concat(this.axes.h).filter((a) => a.label != null);
    }

    ready() {
      if (!this.sides) return false;
      return SIDE_ORDER.some((k) => this.sides[k] && this.sides[k].axes.length >= 1);
    }

    setHighlight(axes) {
      this.highlightAxes = axes && axes.length ? axes : null;
      this.requestRender();
    }

    toggleAxis(ax) {
      if (this.enabled.has(ax)) this.enabled.delete(ax);
      else this.enabled.add(ax);
      const row = this._rowMap.get(ax);
      if (row) {
        row.cb.checked = this.enabled.has(ax);
        row.tr.classList.toggle("off", !this.enabled.has(ax));
      }
      this.rebuildSides();
      this.renderPickup();
      this.requestRender();
      ZC.ui.updateRunButton();
    }

    // ---- 座標変換 -------------------------------------------------------

    toScreen(x, y) {
      const v = this.view;
      return [v.ox + x * v.scale, v.oy + (this.extract.height - y) * v.scale];
    }

    toPage(sx, sy) {
      const v = this.view;
      return [(sx - v.ox) / v.scale, this.extract.height - (sy - v.oy) / v.scale];
    }

    // 図面の縦横比にビュワーの高さを合わせる（横長の図で下に余白が出るのを防ぐ）。
    // 利用者が下端をドラッグして高さを変えた後は触らない。
    autoHeight() {
      if (!this.extract || !this.$wrap || this.userSizedViewer) return;
      const w = this.$wrap.clientWidth;
      if (!w) return;
      const h = (w * this.extract.height) / Math.max(this.extract.width, 1);
      this.autoHeightPx = Math.round(Math.min(1100, Math.max(320, h)));
      this.$wrap.style.height = this.autoHeightPx + "px";
    }

    fit() {
      if (!this.extract) return;
      const W = this.$canvas.clientWidth || 600;
      const H = this.$canvas.clientHeight || 380;
      const pad = 10;
      const k = Math.min((W - pad * 2) / this.extract.width, (H - pad * 2) / this.extract.height);
      this.view = {
        scale: k,
        ox: (W - this.extract.width * k) / 2,
        oy: (H - this.extract.height * k) / 2,
        fitScale: k,
      };
    }

    // ---- 入力イベント ----------------------------------------------------

    _onWheel(e) {
      if (!this.extract) return;
      e.preventDefault();
      if (!this.view) this.fit();
      const v = this.view;
      const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      const k2 = Math.min(v.fitScale * 800, Math.max(v.fitScale * 0.15, v.scale * factor));
      const mx = e.offsetX;
      const my = e.offsetY;
      v.ox = mx - ((mx - v.ox) * k2) / v.scale;
      v.oy = my - ((my - v.oy) * k2) / v.scale;
      v.scale = k2;
      this.requestRender();
    }

    _onDown(e) {
      if (!this.extract || e.button !== 0) return;
      e.preventDefault();
      this._drag = { mx: e.offsetX, my: e.offsetY, ox: this.view.ox, oy: this.view.oy, moved: false };
    }

    _onMove(e) {
      if (!this.extract || !this.view) return;
      const mx = e.offsetX;
      const my = e.offsetY;
      if (this._drag) {
        const dx = mx - this._drag.mx;
        const dy = my - this._drag.my;
        if (Math.abs(dx) + Math.abs(dy) > 3) this._drag.moved = true;
        if (this._drag.moved) {
          this.view.ox = this._drag.ox + dx;
          this.view.oy = this._drag.oy + dy;
          this.$canvas.style.cursor = "grabbing";
          this._tip(null);
          this.requestRender();
          return;
        }
      }
      if (this.measuring) {
        const [px, py] = this.toPage(mx, my);
        this._measureCursor = this._snap(px, py);
        this._tip(null);
        this.requestRender();
        return;
      }
      const hit = this._hitAxis(mx, my);
      if (hit !== this.hoverAx) {
        this.hoverAx = hit;
        this._syncRowHl();
        this.requestRender();
      }
      this.$canvas.style.cursor = hit ? "pointer" : "grab";
      this._tip(hit, mx, my);
    }

    _onUp(e) {
      if (!this.extract || !this.view) return;
      const wasDrag = this._drag && this._drag.moved;
      this._drag = null;
      this.$canvas.style.cursor = this.measuring ? "crosshair" : "grab";
      if (wasDrag) return;
      const mx = e.offsetX;
      const my = e.offsetY;
      if (this.measuring) {
        const [px, py] = this.toPage(mx, my);
        const pt = this._snap(px, py);
        if (!this.measureTemp) {
          this.measureTemp = pt;
          this.measure = null;
        } else {
          this.measure = { a: this.measureTemp, b: pt };
          this.measureTemp = null;
        }
        this.requestRender();
        return;
      }
      const hit = this._hitAxis(mx, my);
      if (hit) {
        this.toggleAxis(hit);
        this._tip(hit, mx, my);
      }
    }

    // 画面座標での芯のヒットテスト（符号付きの芯のみ・6px以内）
    _hitAxis(mx, my) {
      if (!this.view) return null;
      let best = null;
      let bestD = 6;
      for (const ax of this.labeledAxes()) {
        let d;
        if (ax.dir === "v") {
          const [sx] = this.toScreen(ax.pos, 0);
          const [, sy1] = this.toScreen(0, ax.to);
          const [, sy2] = this.toScreen(0, ax.from);
          if (my < sy1 - 6 || my > sy2 + 6) continue;
          d = Math.abs(mx - sx);
        } else {
          const [, sy] = this.toScreen(0, ax.pos);
          const [sx1] = this.toScreen(ax.from, 0);
          const [sx2] = this.toScreen(ax.to, 0);
          if (mx < sx1 - 6 || mx > sx2 + 6) continue;
          d = Math.abs(my - sy);
        }
        if (d < bestD) {
          bestD = d;
          best = ax;
        }
      }
      return best;
    }

    // 測定点のスナップ（芯の位置・線分端点）
    _snap(px, py) {
      const tol = 8 / this.view.scale;
      let sx = px;
      let sy = py;
      let dx = tol;
      let dy = tol;
      let snapped = false;
      for (const ax of this.labeledAxes()) {
        if (ax.dir === "v") {
          const d = Math.abs(px - ax.pos);
          if (d < dx) {
            dx = d;
            sx = ax.pos;
            snapped = true;
          }
        } else {
          const d = Math.abs(py - ax.pos);
          if (d < dy) {
            dy = d;
            sy = ax.pos;
            snapped = true;
          }
        }
      }
      if (this.extract.segments.length <= 30000) {
        let bd = snapped ? Math.hypot(sx - px, sy - py) : tol;
        for (const s of this.extract.segments) {
          const d1 = Math.hypot(px - s.x1, py - s.y1);
          if (d1 < bd) {
            bd = d1;
            sx = s.x1;
            sy = s.y1;
            snapped = true;
          }
          const d2 = Math.hypot(px - s.x2, py - s.y2);
          if (d2 < bd) {
            bd = d2;
            sx = s.x2;
            sy = s.y2;
            snapped = true;
          }
        }
      }
      return { x: sx, y: sy, snapped };
    }

    _tip(ax, mx, my) {
      if (!ax) {
        this.$tip.style.display = "none";
        return;
      }
      const sides = ax.bubbles.map((b) => ZC.axis.SIDE_NAME[b.side]).join("・");
      this.$tip.textContent =
        ax.label + "  " + (sides ? "符号: " + sides : "") +
        " / " + (ax.dashed ? "鎖線" : "実線") +
        (this.enabled.has(ax) ? " / 拾い出し対象" : " / 対象外（クリックでON）");
      this.$tip.style.display = "block";
      const ww = this.$wrap.clientWidth;
      const tw = this.$tip.offsetWidth;
      this.$tip.style.left = Math.max(2, Math.min(mx + 14, ww - tw - 4)) + "px";
      this.$tip.style.top = my + 16 + "px";
    }

    _syncRowHl() {
      for (const [ax, row] of this._rowMap) {
        row.tr.classList.toggle("hl", ax === this.hoverAx);
      }
    }

    // ---- 描画 ------------------------------------------------------------

    requestRender() {
      if (this._raf) return;
      const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (f) => setTimeout(f, 16);
      this._raf = raf(() => {
        this._raf = 0;
        this.renderCanvas();
      });
    }

    renderCanvas() {
      const cv = this.$canvas;
      const cssW = cv.clientWidth || 600;
      const cssH = cv.clientHeight || 380;
      const dpr = globalThis.devicePixelRatio || 1;
      if (cv.width !== Math.round(cssW * dpr) || cv.height !== Math.round(cssH * dpr)) {
        cv.width = Math.round(cssW * dpr);
        cv.height = Math.round(cssH * dpr);
      }
      const ctx = cv.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, cssW, cssH);
      if (!this.extract || !this.extract.segments.length) {
        this.$zoom.textContent = "—";
        ctx.fillStyle = "#8a939b";
        ctx.font = "13px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(
          this.doc ? "表示できる線分がありません" : "PDFを読み込むとここにプレビューが表示されます",
          cssW / 2,
          cssH / 2
        );
        return;
      }
      if (!this.view) this.fit();
      const v = this.view;
      this.$zoom.textContent = Math.round((v.scale / v.fitScale) * 100) + "%";

      const [px0, py1] = this.toPage(0, 0);
      const [px1, py0] = this.toPage(cssW, cssH);
      const m = 2 / v.scale;

      ctx.lineWidth = 0.6;
      ctx.strokeStyle = COLORS.seg;
      ctx.beginPath();
      const segs = this.extract.segments;
      const maxDraw = 200000;
      for (let i = 0; i < segs.length && i < maxDraw; i++) {
        const s = segs[i];
        if (Math.max(s.x1, s.x2) < px0 - m || Math.min(s.x1, s.x2) > px1 + m) continue;
        if (Math.max(s.y1, s.y2) < py0 - m || Math.min(s.y1, s.y2) > py1 + m) continue;
        const a = this.toScreen(s.x1, s.y1);
        const b = this.toScreen(s.x2, s.y2);
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
      }
      ctx.stroke();

      this._drawHighlightBand(ctx);
      this._drawAxes(ctx);
      if (this.showDims) this._drawDims(ctx);
      this._drawMeasure(ctx);
    }

    _axisScreenSeg(ax) {
      if (ax.dir === "v") {
        const [sx] = this.toScreen(ax.pos, 0);
        const [, sy1] = this.toScreen(0, ax.to);
        const [, sy2] = this.toScreen(0, ax.from);
        return [sx, sy1, sx, sy2];
      }
      const [, sy] = this.toScreen(0, ax.pos);
      const [sx1] = this.toScreen(ax.from, 0);
      const [sx2] = this.toScreen(ax.to, 0);
      return [sx1, sy, sx2, sy];
    }

    _drawAxes(ctx) {
      const hl = this.highlightAxes;
      for (const ax of this.labeledAxes()) {
        const on = this.enabled.has(ax);
        const hover = this.hoverAx === ax || (hl && hl.includes(ax));
        ctx.lineWidth = hover ? 2.5 : on ? 1.6 : 1;
        ctx.strokeStyle = hover ? COLORS.hover : !on ? COLORS.off : ax.dir === "v" ? COLORS.v : COLORS.h;
        ctx.setLineDash(on || hover ? [7, 3, 2, 3] : [2, 3]);
        const [x1, y1, x2, y2] = this._axisScreenSeg(ax);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = hover ? COLORS.hover : ax.dir === "v" ? COLORS.v : COLORS.h;
        ctx.font = "bold 11px sans-serif";
        // 符号バブルの位置に表示（上下・左右の両方）
        for (const b of ax.bubbles) {
          const [bx, by] = this.toScreen(b.x, b.y);
          ctx.textAlign = "center";
          haloText(ctx, ax.label, bx, by + 4);
        }
      }
    }

    _drawHighlightBand(ctx) {
      const hl = this.highlightAxes;
      if (!hl || hl.length < 2) return;
      const dirs = new Set(hl.map((a) => a.dir));
      if (dirs.size !== 1) return;
      const sorted = hl.slice().sort((a, b) => a.pos - b.pos);
      const a = sorted[0];
      const b = sorted[sorted.length - 1];
      ctx.fillStyle = "rgba(245,130,10,0.13)";
      if (a.dir === "v") {
        const [x1] = this.toScreen(a.pos, 0);
        const [x2] = this.toScreen(b.pos, 0);
        const [, yTop] = this.toScreen(0, Math.max(a.to, b.to));
        const [, yBot] = this.toScreen(0, Math.min(a.from, b.from));
        ctx.fillRect(x1, yTop, x2 - x1, yBot - yTop);
      } else {
        const [, y1] = this.toScreen(0, b.pos);
        const [, y2] = this.toScreen(0, a.pos);
        const [xL] = this.toScreen(Math.min(a.from, b.from), 0);
        const [xR] = this.toScreen(Math.max(a.to, b.to), 0);
        ctx.fillRect(xL, y1, xR - xL, y2 - y1);
      }
    }

    // 辺ごとの記載寸法を図上に表示
    _drawDims(ctx) {
      if (!this.sides) return;
      ctx.font = "11px sans-serif";
      ctx.strokeStyle = COLORS.dim;
      ctx.fillStyle = COLORS.dim;
      ctx.lineWidth = 1;
      for (const key of SIDE_ORDER) {
        const s = this.sides[key];
        if (!s || s.axes.length < 2) continue;
        if (s.dir === "v") {
          const outer =
            key === "top"
              ? Math.max(...s.axes.map((a) => a.to))
              : Math.min(...s.axes.map((a) => a.from));
          const [, yBase] = this.toScreen(0, outer);
          const y = key === "top" ? yBase - 20 : yBase + 22;
          const [xs] = this.toScreen(s.axes[0].pos, 0);
          const [xe] = this.toScreen(s.axes[s.axes.length - 1].pos, 0);
          ctx.beginPath();
          ctx.moveTo(xs, y);
          ctx.lineTo(xe, y);
          for (const ax of s.axes) {
            const [sx] = this.toScreen(ax.pos, 0);
            ctx.moveTo(sx, y - 4);
            ctx.lineTo(sx, y + 4);
          }
          ctx.stroke();
          ctx.textAlign = "center";
          for (const sp of s.spans) {
            const [x1] = this.toScreen(sp.fromAx.pos, 0);
            const [x2] = this.toScreen(sp.toAx.pos, 0);
            if (x2 - x1 < 34) continue;
            const val = sp.value == null ? "—" : ZC.sides.fmtVal(sp.value) + (sp.parts && sp.parts.length > 1 ? "*" : "");
            haloText(ctx, val, (x1 + x2) / 2, y - 4);
          }
        } else {
          const outer =
            key === "right"
              ? Math.max(...s.axes.map((a) => a.to))
              : Math.min(...s.axes.map((a) => a.from));
          const [xBase] = this.toScreen(outer, 0);
          const x = key === "right" ? xBase + 20 : xBase - 20;
          const [, ys] = this.toScreen(0, s.axes[0].pos);
          const [, ye] = this.toScreen(0, s.axes[s.axes.length - 1].pos);
          ctx.beginPath();
          ctx.moveTo(x, ys);
          ctx.lineTo(x, ye);
          for (const ax of s.axes) {
            const [, sy] = this.toScreen(0, ax.pos);
            ctx.moveTo(x - 4, sy);
            ctx.lineTo(x + 4, sy);
          }
          ctx.stroke();
          for (const sp of s.spans) {
            const [, y1] = this.toScreen(0, sp.fromAx.pos);
            const [, y2] = this.toScreen(0, sp.toAx.pos);
            if (y1 - y2 < 34) continue;
            const val = sp.value == null ? "—" : ZC.sides.fmtVal(sp.value) + (sp.parts && sp.parts.length > 1 ? "*" : "");
            ctx.save();
            ctx.translate(x - 4, (y1 + y2) / 2);
            ctx.rotate(-Math.PI / 2);
            ctx.textAlign = "center";
            haloText(ctx, val, 0, 0);
            ctx.restore();
          }
        }
      }
    }

    _drawMeasure(ctx) {
      const a = this.measure ? this.measure.a : this.measureTemp;
      const b = this.measure ? this.measure.b : this.measuring ? this._measureCursor : null;
      if (!a) return;
      const pA = this.toScreen(a.x, a.y);
      ctx.fillStyle = COLORS.measure;
      ctx.strokeStyle = COLORS.measure;
      const mark = (p, snapped) => {
        ctx.beginPath();
        if (snapped) ctx.rect(p[0] - 3.5, p[1] - 3.5, 7, 7);
        else ctx.arc(p[0], p[1], 3, 0, Math.PI * 2);
        ctx.fill();
      };
      mark(pA, a.snapped);
      if (!b) return;
      const pB = this.toScreen(b.x, b.y);
      mark(pB, b.snapped);
      ctx.lineWidth = 1.4;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(pA[0], pA[1]);
      ctx.lineTo(pB[0], pB[1]);
      ctx.stroke();
      ctx.setLineDash([]);
      // 縮尺を使わないため図面上の長さ(pt)で表示する
      const dx = Math.abs(b.x - a.x);
      const dy = Math.abs(b.y - a.y);
      const label =
        Math.hypot(dx, dy).toFixed(1) + " pt（ΔX " + dx.toFixed(1) + " / ΔY " + dy.toFixed(1) + "）";
      ctx.font = "bold 12px sans-serif";
      ctx.textAlign = "left";
      haloText(ctx, label, (pA[0] + pB[0]) / 2 + 8, (pA[1] + pB[1]) / 2 - 8);
    }

    // ---- 拾い出し結果・一覧 ---------------------------------------------

    renderPickup() {
      renderSideBlocks(this.$pickup, this.sides);
    }

    renderList() {
      this.$list.innerHTML = "";
      this._rowMap = new Map();
      const axes = this.labeledAxes();
      if (!axes.length) return;
      const table = el("table", { class: "axes" });
      const thead = el("thead");
      thead.innerHTML = "<tr><th>拾い出し</th><th>方向</th><th>符号</th><th>符号の辺</th><th>線種</th></tr>";
      table.appendChild(thead);
      const tbody = el("tbody");
      for (const ax of axes) {
        const tr = el("tr", {
          class: this.enabled.has(ax) ? "" : "off",
          onmouseenter: () => {
            this.hoverAx = ax;
            this.requestRender();
          },
          onmouseleave: () => {
            this.hoverAx = null;
            this.requestRender();
          },
        });
        const cb = el("input", { type: "checkbox" });
        cb.checked = this.enabled.has(ax);
        cb.addEventListener("change", () => {
          if (cb.checked) this.enabled.add(ax);
          else this.enabled.delete(ax);
          tr.className = cb.checked ? "" : "off";
          this.rebuildSides();
          this.renderPickup();
          this.requestRender();
          ZC.ui.updateRunButton();
        });
        this._rowMap.set(ax, { tr, cb });
        tr.appendChild(el("td", {}, [cb]));
        tr.appendChild(el("td", { text: ax.dir === "v" ? "縦(X)" : "横(Y)" }));
        tr.appendChild(el("td", { text: ax.label }));
        tr.appendChild(el("td", { text: ax.bubbles.map((b) => ZC.axis.SIDE_NAME[b.side]).join("・") }));
        tr.appendChild(el("td", { text: ax.dashed ? "鎖線/破線" : "実線" }));
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
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          ui.base.cancelMeasure();
          ui.cmp.cancelMeasure();
        }
      });
      globalThis.addEventListener("resize", () => {
        ui.base.requestRender();
        ui.cmp.requestRender();
      });
      ui.updateRunButton();
    },

    updateRunButton() {
      const btn = document.getElementById("run-check");
      if (btn) btn.disabled = !(ui.base && ui.cmp && ui.base.ready() && ui.cmp.ready());
    },

    runCheck() {
      const tol = Number(document.getElementById("tol").value) || 1;
      const checks = {
        labels: document.getElementById("ck-labels").checked,
        spacing: document.getElementById("ck-spacing").checked,
        total: document.getElementById("ck-total").checked,
      };
      const result = ZC.compare.compare(
        { sides: ui.base.sides, name: "基準" },
        { sides: ui.cmp.sides, name: "比較" },
        { tol, checks }
      );
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
        wrap.appendChild(el("p", { text: "チェック項目が選択されていないか、対応する通り芯がありません。" }));
        document.getElementById("csv-dl").hidden = true;
        return;
      }
      wrap.appendChild(
        el("p", { class: "result-hint", text: "行にカーソルを乗せると該当箇所が両方のビュワーで強調表示されます。" })
      );
      const table = el("table", { class: "result" });
      const thead = el("thead");
      thead.innerHTML =
        "<tr><th>判定</th><th>辺</th><th>チェック</th><th>対象</th><th>基準</th><th>比較</th><th>差(mm)</th><th>備考</th></tr>";
      table.appendChild(thead);
      const tbody = el("tbody");
      for (const r of result.rows) {
        const tr = el("tr", { class: r.status.toLowerCase() });
        if (r.refs) {
          tr.addEventListener("mouseenter", () => {
            ui.base.setHighlight(r.refs.b);
            ui.cmp.setHighlight(r.refs.c);
          });
          tr.addEventListener("mouseleave", () => {
            ui.base.setHighlight(null);
            ui.cmp.setHighlight(null);
          });
        }
        tr.appendChild(el("td", { text: r.status === "WARN" ? "要確認" : r.status, class: "st" }));
        tr.appendChild(el("td", { text: r.side }));
        tr.appendChild(el("td", { text: r.check }));
        tr.appendChild(el("td", { text: r.item }));
        tr.appendChild(el("td", { text: String(r.base) }));
        tr.appendChild(el("td", { text: String(r.cmp) }));
        tr.appendChild(el("td", { text: r.diff == null ? "—" : (r.diff > 0 ? "+" : "") + ZC.sides.fmtVal(r.diff) }));
        tr.appendChild(el("td", { text: r.note }));
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      wrap.appendChild(table);
      document.getElementById("csv-dl").hidden = false;
    },

    downloadCsv() {
      if (!ui.lastResult) return;
      const head = ["判定", "辺", "チェック", "対象", "基準", "比較", "差(mm)", "備考"];
      const lines = [head.join(",")];
      for (const r of ui.lastResult.rows) {
        const cells = [
          r.status,
          r.side,
          r.check,
          r.item,
          String(r.base),
          String(r.cmp),
          r.diff == null ? "" : ZC.sides.fmtVal(r.diff),
          r.note,
        ].map((c) => '"' + String(c).replace(/"/g, '""') + '"');
        lines.push(cells.join(","));
      }
      // Excel で文字化けしないよう BOM 付き UTF-8
      const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "zumen-check.csv";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    },
  };

  ZC.ui = ui;
})(globalThis.ZC = globalThis.ZC || {});
