// UI 層: ファイル読み込み・対話ビュワー（ズーム/パン/測定/寸法表示）・芯リスト・照合結果表示
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
      this.dimsInfo = { dots: [], entries: [] };
      this.enabled = new Set();
      this.fileName = "";
      // ビュワー状態
      this.view = null; // {scale, ox, oy, fitScale}
      this.showDims = true;
      this.measuring = false;
      this.measure = null; // {a:{x,y}, b:{x,y}} ページ座標
      this.measureTemp = null;
      this._measureCursor = null;
      this.hoverAx = null;
      this.highlightAxes = null; // 照合結果ホバーからの強調
      this._rowMap = new Map(); // axis -> {tr, cb}
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
        '<div class="ctrl-row">' +
        '<label>ページ <select class="page-sel" disabled></select></label>' +
        '<label>縮尺 1/<input class="scale-in" type="number" value="100" min="1" step="any"></label>' +
        '<span class="scale-note"></span>' +
        "</div>" +
        '<div class="status"></div>' +
        '<div class="viewer-bar">' +
        '<button type="button" class="vb-fit" title="全体表示（ダブルクリックでも可）">フィット</button>' +
        '<button type="button" class="vb-measure" title="2点間の距離を測る（芯・端点にスナップ / Escで解除）">測定</button>' +
        '<label title="チェック中の芯の芯々寸法を図上に表示"><input type="checkbox" class="vb-dims" checked> 寸法表示</label>' +
        '<span class="zoom-label">—</span>' +
        '<span class="viewer-hint">ホイール:拡大縮小 / ドラッグ:移動 / 芯クリック:照合ON/OFF</span>' +
        "</div>" +
        '<div class="viewer-wrap"><canvas class="preview"></canvas><div class="axtip"></div></div>' +
        '<div class="axis-list"></div>';
      this.$file = this.root.querySelector('input[type="file"]');
      this.$fname = this.root.querySelector(".fname");
      this.$page = this.root.querySelector(".page-sel");
      this.$scale = this.root.querySelector(".scale-in");
      this.$scaleNote = this.root.querySelector(".scale-note");
      this.$status = this.root.querySelector(".status");
      this.$wrap = this.root.querySelector(".viewer-wrap");
      this.$canvas = this.root.querySelector("canvas");
      this.$tip = this.root.querySelector(".axtip");
      this.$list = this.root.querySelector(".axis-list");
      this.$zoom = this.root.querySelector(".zoom-label");
      this.$fit = this.root.querySelector(".vb-fit");
      this.$measureBtn = this.root.querySelector(".vb-measure");
      this.$dims = this.root.querySelector(".vb-dims");

      this.$file.addEventListener("change", () => this._onFile());
      this.$page.addEventListener("change", () => this.loadPage(Number(this.$page.value)));
      this.$scale.addEventListener("input", () => {
        this.requestRender();
        this.renderList();
        ZC.ui.updateRunButton();
      });
      this.$fit.addEventListener("click", () => {
        this.fit();
        this.requestRender();
      });
      this.$measureBtn.addEventListener("click", () => this.setMeasuring(!this.measuring));
      this.$dims.addEventListener("change", () => {
        this.showDims = this.$dims.checked;
        this.requestRender();
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
        this._syncRowHl();
        this.requestRender();
      });
      cv.addEventListener("dblclick", () => {
        this.fit();
        this.requestRender();
      });
      if (typeof ResizeObserver !== "undefined") {
        new ResizeObserver(() => this.requestRender()).observe(this.$wrap);
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

    // Esc: 測定の解除
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
      this.doc = null;
      this.pages = [];
      this.extract = null;
      this.axes = { v: [], h: [] };
      this.dimsInfo = { dots: [], entries: [] };
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
        this.requestRender();
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
        this.view = null; // 再フィット
        this.measure = null;
        this.measureTemp = null;
        this.highlightAxes = null;
        // 記載寸法（黒ドット間の注記）の抽出
        this.dimsInfo = ZC.dims.extract(this.extract);
        // 縮尺の自動推定: ドット基準の寸法があればそれを、無ければ近似（芯間中央の数字）で
        let samples = ZC.dims.scaleSamples(this.dimsInfo.entries);
        let src = "記載寸法" + samples.length + "件より";
        if (!samples.length) {
          const onV = det.v.filter((a) => this.enabled.has(a));
          const onH = det.h.filter((a) => this.enabled.has(a));
          samples = ZC.scale.collectDimSamples(onV, onH, this.extract.texts);
          src = "寸法値" + samples.length + "件より（近似）";
        }
        const inf = ZC.scale.infer(samples);
        if (inf.den != null) {
          const den = inf.snapped ? inf.den : Math.round(inf.den * 10) / 10;
          this.$scale.value = String(den);
          this.$scaleNote.textContent = "自動推定 1/" + den + "（" + src + "）";
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
            "通り芯候補: 縦" + det.v.length + "本 / 横" + det.h.length + "本（うち" + on + "本をチェック済み）" +
              " / 記載寸法 " + this.dimsInfo.entries.length + "区間を読取。誤検出はチェックを外してください。"
          );
        }
      } catch (e) {
        this.extract = null;
        this.axes = { v: [], h: [] };
        this.dimsInfo = { dots: [], entries: [] };
        this.setStatus("解析に失敗しました: " + (e && e.message ? e.message : e), "error");
      }
      this.requestRender();
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
      return !!(this.extract && this.enabled.size >= 1 && this.mmPerPt());
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
      this.requestRender();
      ZC.ui.updateRunButton();
    }

    // ---- 座標変換 -------------------------------------------------------
    // ページ座標(pt, y上向き) ⇔ キャンバスCSS座標(y下向き)

    toScreen(x, y) {
      const v = this.view;
      return [v.ox + x * v.scale, v.oy + (this.extract.height - y) * v.scale];
    }

    toPage(sx, sy) {
      const v = this.view;
      return [(sx - v.ox) / v.scale, this.extract.height - (sy - v.oy) / v.scale];
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
      // ホバー判定
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
        this._tip(hit, mx, my); // ON/OFF後の状態をツールチップへ即反映
      }
    }

    // 画面座標での芯のヒットテスト（6px以内）
    _hitAxis(mx, my) {
      if (!this.view) return null;
      let best = null;
      let bestD = 6;
      for (const ax of this.allAxes()) {
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
      for (const ax of this.allAxes()) {
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
        // 端点は「現在のスナップ結果より近い」場合のみ採用する
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
      const mmp = this.mmPerPt();
      const pos = mmp ? U.fmtMm(ax.pos * mmp, 0) + " mm" : U.fmtMm(ax.pos, 1) + " pt";
      const len = mmp ? U.fmtMm(ax.extent * mmp, 0) + " mm" : U.fmtMm(ax.extent, 1) + " pt";
      this.$tip.textContent =
        ZC.axis.displayName(ax) +
        "  位置 " + pos + " / 長さ " + len +
        " / " + (ax.dashed ? "鎖線" : "実線") +
        (ax.frameSuspect ? "・図枠?" : "") +
        (this.enabled.has(ax) ? " / 照合対象" : " / 対象外（クリックでON）");
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

      // 可視範囲（ページ座標）— 範囲外の線分は描かない
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
      for (const ax of this.allAxes()) {
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
        if (on || hover) {
          const name = ZC.axis.displayName(ax);
          ctx.fillStyle = hover ? COLORS.hover : ax.dir === "v" ? COLORS.v : COLORS.h;
          ctx.font = "bold 11px sans-serif";
          if (ax.dir === "v") {
            ctx.textAlign = "center";
            haloText(ctx, name, x1, y1 - 4);
          } else {
            ctx.textAlign = "right";
            haloText(ctx, name, x1 - 4, y1 + 4);
          }
        }
      }
    }

    // 照合結果ホバー時の強調帯（2本ならその間を塗る）
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

    // 隣接ペアの表示値: 記載寸法（分割は合計）を優先、無ければ作図距離×縮尺に「≈」を付ける
    _pairText(dir, a, b, mmp) {
      const annot = ZC.dims.spanValue(this.dimsInfo.entries, dir, a.pos, b.pos);
      if (annot) {
        const v = annot.value;
        return U.fmtMm(v, Number.isInteger(v) ? 0 : 1) + (annot.parts.length > 1 ? "*" : "");
      }
      if (!mmp) return "";
      return "≈" + U.fmtMm(Math.abs(b.pos - a.pos) * mmp, 0);
    }

    // 芯々寸法のオーバーレイ（チェック中の芯のみ・値は図面の記載寸法を優先）
    _drawDims(ctx) {
      const mmp = this.mmPerPt();
      const en = this.enabledAxes();
      ctx.font = "11px sans-serif";
      ctx.strokeStyle = COLORS.dim;
      ctx.fillStyle = COLORS.dim;
      ctx.lineWidth = 1;

      // 縦芯（上側に水平の寸法線）
      const vs = en.v.slice().sort((a, b) => a.pos - b.pos);
      if (vs.length >= 2) {
        const topPage = Math.max(...vs.map((a) => a.to));
        const [, yDim] = this.toScreen(0, topPage);
        const y = yDim - 22;
        const [xs] = this.toScreen(vs[0].pos, 0);
        const [xe] = this.toScreen(vs[vs.length - 1].pos, 0);
        ctx.beginPath();
        ctx.moveTo(xs, y);
        ctx.lineTo(xe, y);
        for (const ax of vs) {
          const [sx] = this.toScreen(ax.pos, 0);
          ctx.moveTo(sx, y - 4);
          ctx.lineTo(sx, y + 4);
        }
        ctx.stroke();
        ctx.textAlign = "center";
        for (let i = 0; i + 1 < vs.length; i++) {
          const [x1] = this.toScreen(vs[i].pos, 0);
          const [x2] = this.toScreen(vs[i + 1].pos, 0);
          if (x2 - x1 < 34) continue; // 狭すぎる区間は省略
          const val = this._pairText("v", vs[i], vs[i + 1], mmp);
          if (val) haloText(ctx, val, (x1 + x2) / 2, y - 4);
        }
      }

      // 横芯（左側に垂直の寸法線・文字は90度回転）
      const hs = en.h.slice().sort((a, b) => a.pos - b.pos);
      if (hs.length >= 2) {
        const leftPage = Math.min(...hs.map((a) => a.from));
        const [xDim] = this.toScreen(leftPage, 0);
        const x = xDim - 22;
        const [, ys] = this.toScreen(0, hs[0].pos);
        const [, ye] = this.toScreen(0, hs[hs.length - 1].pos);
        ctx.beginPath();
        ctx.moveTo(x, ys);
        ctx.lineTo(x, ye);
        for (const ax of hs) {
          const [, sy] = this.toScreen(0, ax.pos);
          ctx.moveTo(x - 4, sy);
          ctx.lineTo(x + 4, sy);
        }
        ctx.stroke();
        for (let i = 0; i + 1 < hs.length; i++) {
          const [, y1] = this.toScreen(0, hs[i].pos);
          const [, y2] = this.toScreen(0, hs[i + 1].pos);
          if (y1 - y2 < 34) continue;
          const val = this._pairText("h", hs[i], hs[i + 1], mmp);
          if (!val) continue;
          ctx.save();
          ctx.translate(x - 4, (y1 + y2) / 2);
          ctx.rotate(-Math.PI / 2);
          ctx.textAlign = "center";
          haloText(ctx, val, 0, 0);
          ctx.restore();
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
      const mmp = this.mmPerPt();
      const f = (val) => U.fmtMm(val * (mmp || 1), 1);
      const unit = mmp ? "mm" : "pt";
      const dx = Math.abs(b.x - a.x);
      const dy = Math.abs(b.y - a.y);
      const len = Math.hypot(dx, dy);
      const label = f(len) + " " + unit + "（ΔX " + f(dx) + " / ΔY " + f(dy) + "）";
      ctx.font = "bold 12px sans-serif";
      ctx.textAlign = "left";
      const mx = (pA[0] + pB[0]) / 2 + 8;
      const my = (pA[1] + pB[1]) / 2 - 8;
      haloText(ctx, label, mx, my);
    }

    // ---- 一覧 ------------------------------------------------------------

    renderList() {
      this.$list.innerHTML = "";
      this._rowMap = new Map();
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
          this.requestRender();
          ZC.ui.updateRunButton();
        });
        this._rowMap.set(ax, { tr, cb });
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

    gatherSide(panel, name) {
      const en = panel.enabledAxes();
      const mmPerPt = panel.mmPerPt();
      return {
        v: en.v,
        h: en.h,
        mmPerPt,
        entries: panel.dimsInfo.entries,
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
      wrap.appendChild(
        el("p", { class: "result-hint", text: "行にカーソルを乗せると該当箇所が両方のビュワーで強調表示されます。" })
      );
      const table = el("table", { class: "result" });
      const thead = el("thead");
      thead.innerHTML =
        "<tr><th>判定</th><th>チェック</th><th>方向</th><th>対象</th><th>基準</th><th>比較</th><th>差(mm)</th><th>備考</th></tr>";
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
