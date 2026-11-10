// UI 層: ファイル読み込み・対話ビュワー（ズーム/パン/測定）・辺別の拾い出し・照合結果表示
// DOM を触るのはこのファイルと 31_app.js のみ（テストは 2x系までのロジックを対象とする）
(function (ZC) {
  "use strict";

  const SIDE_ORDER = ["top", "right", "bottom", "left"];

  const COLORS = {
    diff: "#d4002a",     // 照合で差異が出た箇所（赤）
    diffWarn: "#c77700", // 〃 要確認（橙）
    same: "#e8b400",     // 左右で一致した箇所（黄）
    seg: "#4a5560", // 図面の線。薄くすると寸法線や数字が白っぽくなって読めない
    v: "#1565d8",
    h: "#0a8f4e",
    off: "#c7c7c7",
    hover: "#f5820a",
    dim: "#a15c00",
    other: "#7a3fa8",
    measure: "#d81b60",
  };

  const SEG_MIN_WIDTH = 0.7; // 図面の線の最小太さ(CSS px)
  const SEG_MAX_WIDTH = 3; // 〃 最大（拡大しても潰れないように）
  const TEXT_MIN_PX = 4; // PDFの文字を描く最小サイズ(px)。これ未満は潰れるだけ
  const SPLIT_AUTO_PAGES = 4; // このページ数までは読み込み時に自動で分割を判定する
  const MARK_MIN_PX = 7; // 符号・数字の塗りの最小の大きさ(px)。縮小時でも見えるように
  const MARK_ALPHA = 0.2; // 照合結果の塗りの濃さ（レイヤをまとめて重ねるとき）
  // 照合結果の塗り分け。一致=黄 / 要確認=橙 / 差異=赤。
  // 塗りは**不透明な色で別レイヤに描いてから**まとめて薄く重ねる。
  // X方向の帯とY方向の帯は図面の上で必ず交差するので、そのまま半透明で塗ると
  // 交差部だけ二重に濃くなり、赤の上に黄が乗って色が濁る。レイヤに
  // 一致→要確認→差異の順で不透明に描けば、どの画素も「一番重い判定の色」1色になる。
  const MARK_STYLE = {
    // extra … 差異を一致より濃くするための追い塗り（同じ色なので濁らない）
    OK: { fill: "#ffd600", pad: 2, line: null, extra: 0.18, label: false },
    WARN: { fill: "#e08a00", pad: 3, line: COLORS.diffWarn, dash: [4, 2], width: 1.2, extra: 0.3, label: false },
    NG: { fill: "#e3002c", pad: 3, line: COLORS.diff, dash: [], width: 1.6, extra: 0.4, label: true },
  };
  const MARK_ORDER = ["OK", "WARN", "NG"];

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

  // ---- 線で描かれた文字の対応表 --------------------------------------
  // フォントの指紋ごとに localStorage へ保存する。同じCAD・同じフォントの
  // 図面なら、一度教えれば次からは自動で読める。
  // 対応表は**図面をまたいで1つ**にためる。字形の照合は完全一致ではなく
  // 「一番近い鍵」なので、同じCADの別の図面でもそのまま効く。新しい図面で
  // 未登録の字形が出たら、そのぶんだけ足していく。
  const GLYPH_STORE = "zc.glyphmap";
  const GLYPH_STORE_OLD = "zc.glyphmap."; // 図面ごとに保存していた頃の鍵
  const GLYPH_MAX = 4000; // ためこむ字形の上限

  function loadGlyphMap() {
    let map = {};
    try {
      if (!globalThis.localStorage) return map;
      const raw = localStorage.getItem(GLYPH_STORE);
      if (raw) map = JSON.parse(raw) || {};
      // 図面ごとに保存していた古い対応表を取り込む（一度だけ）
      const olds = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k !== GLYPH_STORE && k.indexOf(GLYPH_STORE_OLD) === 0) olds.push(k);
      }
      if (olds.length) {
        for (const k of olds) {
          try {
            const m = JSON.parse(localStorage.getItem(k)) || {};
            for (const sh in m) if (m[sh] && !map[sh]) map[sh] = m[sh];
          } catch (e) {
            /* 壊れていれば無視 */
          }
          localStorage.removeItem(k);
        }
        localStorage.setItem(GLYPH_STORE, JSON.stringify(map));
      }
    } catch (e) {
      return map;
    }
    return map;
  }

  // 入力された分を既存の対応表に**足して**保存する（置き換えない）
  function saveGlyphMap(add) {
    const map = loadGlyphMap();
    let n = Object.keys(map).length;
    for (const sh in add) {
      if (!add[sh]) {
        delete map[sh];
        continue;
      }
      if (!(sh in map) && n >= GLYPH_MAX) continue;
      if (!(sh in map)) n++;
      map[sh] = add[sh];
    }
    try {
      if (globalThis.localStorage) localStorage.setItem(GLYPH_STORE, JSON.stringify(map));
    } catch (e) {
      /* 保存できなくても読み取りは動く */
    }
    return map;
  }

  // 字形を一覧にして、1つずつ文字を教えてもらう画面。
  // 既に覚えている字形は入力済みで出し、**未登録のものだけ**を足していけばよい。
  // 回転した同じ字形には候補を出すが、自動では決めない
  // （9 が 6 の180度回転のフォントでは取り違えるため、必ず目で確認してもらう）。
  function renderGlyphTeacher(panel, container) {
    const info = panel.ensureGlyphInfo();
    container.innerHTML = "";
    const stored = loadGlyphMap();
    const keyBits = {};
    for (const k in stored) if (stored[k]) keyBits[k] = ZC.glyph.hexToBits(k);

    // 覚えている字形は入力済みにする
    const rows = info.shapes.map((sh) => {
      const key = ZC.glyph.matchShape(ZC.glyph.hexToBits(sh.shape), keyBits, ZC.glyph.aspectOfKey(sh.shape));
      return { sh, known: key ? stored[key] : "" };
    });
    const unknown = rows.filter((r) => !r.known).length;
    rows.sort((a, b) => (a.known ? 1 : 0) - (b.known ? 1 : 0) || b.sh.count - a.sh.count);

    const box = el("div", { class: "teach" });
    box.appendChild(el("div", { class: "teach-title", text: "線で描かれた文字を教える" }));
    box.appendChild(
      el("p", {
        text:
          "各マスの下に、その形が表す文字（0〜9 / . / X / Y）を入力します。" +
          "覚えている字形は入力済みで出ます。文字ではない線の破片は空欄のままにしてください。" +
          "入力した内容はこのブラウザにためられ、次に読む図面でもそのまま使われます。",
      })
    );
    box.appendChild(
      el("div", {
        class: "teach-count",
        text:
          "この図面の字形 " + info.shapes.length + "種／うち未登録 " + unknown + "種" +
          "（覚えている字形 " + Object.keys(stored).length + "種）",
      })
    );

    const grid = el("div", { class: "teach-grid" });
    const inputs = [];
    for (const row of rows.slice(0, 400)) {
      const sh = row.sh;
      const cell = el("div", { class: "teach-cell" + (row.known ? " done" : "") });
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 28 28");
      svg.setAttribute("width", "28");
      svg.setAttribute("height", "28");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      // 実寸比で描く（小数点のような小さな字形がひと目で分かるように）
      path.setAttribute("d", ZC.glyph.shapePath(sh.glyph, 28, info.refHeight));
      path.setAttribute("stroke", "#24313d");
      path.setAttribute("stroke-width", "1.4");
      path.setAttribute("fill", "none");
      svg.appendChild(path);
      cell.appendChild(svg);
      const inp = el("input", { class: "teach-in", type: "text", maxlength: "1" });
      inp.value = row.known || "";
      inp.title = sh.count + "回";
      cell.appendChild(inp);
      cell.appendChild(el("span", { class: "teach-n", text: String(sh.count) }));
      grid.appendChild(cell);
      inputs.push({ sh, inp, cell, known: row.known });
    }
    box.appendChild(grid);

    // 未登録だけ表示（覚えている字形が多いときの既定）
    const onlyNew = el("input", { type: "checkbox", class: "teach-only" });
    onlyNew.checked = unknown > 0 && unknown < rows.length;
    const applyFilter = () => {
      for (const o of inputs) o.cell.hidden = onlyNew.checked && !!o.known;
    };
    onlyNew.addEventListener("change", applyFilter);

    // 入力したら、±90度回した同じ形に候補を入れる（グレー表示・手で直せる）
    const suggest = () => {
      for (const o of inputs) {
        if (o.inp.value && !o.inp.classList.contains("guess")) continue;
        let found = "";
        let many = false;
        for (const src of inputs) {
          if (src === o || !src.inp.value || src.inp.classList.contains("guess")) continue;
          if (src.sh.rot.indexOf(o.sh.shape) < 0) continue;
          if (found && found !== src.inp.value) many = true;
          found = src.inp.value;
        }
        if (many) found = ""; // 複数の文字が候補になるときは出さない
        o.inp.value = found;
        o.inp.classList.toggle("guess", !!found);
      }
    };
    for (const o of inputs) {
      o.inp.addEventListener("input", () => {
        o.inp.classList.remove("guess");
        suggest();
      });
    }
    suggest();
    applyFilter();

    const bar = el("div", { class: "teach-bar" });
    const apply = el("button", { type: "button", class: "teach-apply", text: "この内容で読み取る" });
    const msg = el("span", { class: "teach-msg" });
    apply.addEventListener("click", () => {
      const add = {};
      for (const { sh, inp, known } of inputs) {
        const v = (inp.value || "").trim();
        if (v) add[sh.shape] = v;
        else if (known) add[sh.shape] = ""; // 入力を消したら覚えからも外す
      }
      const merged = saveGlyphMap(add);
      const n = panel.applyGlyphMap(merged);
      msg.textContent = n
        ? n + "件の文字列を読み取りました（覚えている字形 " + Object.keys(merged).length + "種）"
        : "読み取れた文字列がありません";
    });
    bar.appendChild(apply);
    const clear = el("button", { type: "button", class: "teach-clear", text: "入力を消す" });
    clear.addEventListener("click", () => {
      for (const { inp } of inputs) {
        inp.value = "";
        inp.classList.remove("guess");
      }
    });
    bar.appendChild(clear);
    const lbl = el("label", { class: "teach-filter" });
    lbl.appendChild(onlyNew);
    lbl.appendChild(document.createTextNode(" 未登録だけ表示"));
    bar.appendChild(lbl);
    bar.appendChild(msg);
    box.appendChild(bar);
    container.appendChild(box);
  }

  // 読み取り診断: このツールが読める図面かを条件ごとに○×で示し、
  // 満たしていない条件には対処方法を添える。
  function renderDiagnosis(diag, panel) {
    const box = el("div", { class: "diag" });
    box.appendChild(
      el("div", { class: "diag-title", text: "この図面からは拾い出しできません（読み取り条件の診断）" })
    );
    const table = el("table", { class: "diag-table" });
    const tbody = el("tbody");
    for (const c of diag.checks) {
      const tr = el("tr", { class: c.ok ? "ok" : "ng" });
      tr.appendChild(el("td", { class: "mk", text: c.ok ? "○" : "×" }));
      tr.appendChild(el("td", { class: "lb", text: c.label }));
      tr.appendChild(el("td", { class: "dt", text: c.detail }));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    box.appendChild(table);
    const ul = el("ul", { class: "diag-hints" });
    for (const c of diag.failed) ul.appendChild(el("li", { text: c.hint }));
    ul.appendChild(
      el("li", { text: "図面のまま読みたい場合は「AIで総ざらい」をお使いください（AIは図として読みます）" })
    );
    box.appendChild(ul);
    // 文字が線で描かれている図面は、形と文字の対応を教えればこのまま読める
    if (diag.outlined && panel) {
      box.appendChild(glyphTeachBar(panel, "線で描かれた文字を教えて読み取る"));
    }
    return box;
  }

  // 「線で描かれた文字を教える」ボタンと、その下に開く入力画面。
  // 読み取れている図面でも**未登録の字形をその場で足せる**ように、
  // 診断が出ていないときの拾い出し欄にも同じものを置く。
  function glyphTeachBar(panel, label) {
    const bar = el("div", { class: "glyph-bar" });
    const btn = el("button", { type: "button", class: "teach-open", text: label });
    const slot = el("div", { class: "teach-slot" });
    btn.addEventListener("click", () => {
      if (slot.childNodes.length) {
        slot.innerHTML = "";
        return;
      }
      renderGlyphTeacher(panel, slot);
    });
    bar.appendChild(btn);
    const info = panel.glyphInfo;
    if (info) {
      const stored = loadGlyphMap();
      const kb = {};
      for (const k in stored) if (stored[k]) kb[k] = ZC.glyph.hexToBits(k);
      let unknown = 0;
      for (const sh of info.shapes) {
        if (!ZC.glyph.matchShape(ZC.glyph.hexToBits(sh.shape), kb, ZC.glyph.aspectOfKey(sh.shape))) unknown++;
      }
      bar.appendChild(
        el("span", {
          class: "glyph-note" + (unknown ? " warn" : ""),
          text: unknown
            ? "この図面には未登録の字形が " + unknown + " 種あります"
            : "この図面の字形はすべて登録済みです",
        })
      );
    }
    const wrap = el("div");
    wrap.appendChild(bar);
    wrap.appendChild(slot);
    return wrap;
  }

  // 通り芯以外の寸法線（室内寸法・開口幅 W＝ など）を段ごとに一覧する。
  // 段数が多いので、ここだけはスクロールできる箱にする。
  function renderOtherDims(container, others) {
    container.innerHTML = "";
    if (!others) return;
    for (const g of [
      { title: "X方向の寸法線（横向き）", rows: others.v },
      { title: "Y方向の寸法線（縦向き）", rows: others.h },
    ]) {
      const group = el("div", { class: "dir-group" });
      group.appendChild(
        el("div", { class: "dir-title", text: g.title + "　" + g.rows.length + "段" })
      );
      if (!g.rows.length) {
        group.appendChild(el("div", { class: "side-empty", text: "（ありません）" }));
      } else {
        const box = el("div", { class: "other-list" });
        for (const r of g.rows) {
          const line = el("div", { class: "other-row" });
          line.appendChild(el("span", { class: "other-n", text: r.items.length + "区間" }));
          line.appendChild(el("span", { class: "other-v", text: ZC.sides.formatRow(r) }));
          box.appendChild(line);
        }
        group.appendChild(box);
      }
      container.appendChild(group);
    }
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
      this.others = null; // 通り芯以外の寸法線（段ごと）
      this.diag = null; // 文字データの有無の診断
      this.glyphInfo = null; // 線で描かれた文字の解析結果
      this.glyphPage = false; // 文字が線で描かれたページか
      this.glyphMap = null; // 形→文字の対応表
      this.glyphTexts = []; // 対応表で起こした文字列
      this.baseTexts = null; // PDFに元から入っていた文字
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
        '<div class="split-box" hidden></div>' +
        '<div class="viewer-bar">' +
        '<button type="button" class="vb-fit" title="全体表示（ダブルクリックでも可）">フィット</button>' +
        '<button type="button" class="vb-measure" title="2点間の距離を測る（芯・端点にスナップ / Escで解除）">測定</button>' +
        '<label title="記載寸法を図上に表示（表示する種類は下のチェックに従う）"><input type="checkbox" class="vb-dims" checked> 寸法表示</label>' +
        '<span class="zoom-label">—</span>' +
        '<span class="viewer-hint">ホイール:拡大縮小 / ドラッグ:移動 / 芯クリック:拾い出しON/OFF</span>' +
        "</div>" +
        '<div class="viewer-wrap"><canvas class="preview"></canvas><div class="axtip"></div></div>' +
        '<div class="pickup">' +
        '<div class="pickup-head">' +
        '<button type="button" class="pickup-toggle" aria-expanded="false">' +
        '<span class="tri"></span>拾い出し結果</button>' +
        '<span class="pickup-sum"></span>' +
        '<button type="button" class="copy-btn">コピー</button>' +
        '<span class="pickup-show">表示:' +
        '<label title="符号(X○○/Y○○)が付いた通り芯と、その芯々寸法"><input type="checkbox" class="sh-grid" checked> 通り芯</label>' +
        '<label title="通り芯間として拾えなかった寸法線（室内寸法・開口幅 W＝ など）"><input type="checkbox" class="sh-other"> その他の寸法</label>' +
        "</span></div>" +
        '<div class="pickup-body" hidden>' +
        '<div class="pickup-grid"></div><div class="other-dims"></div></div></div>' +
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
      this.$split = this.root.querySelector(".split-box");
      this.$wrap = this.root.querySelector(".viewer-wrap");
      this.$canvas = this.root.querySelector("canvas");
      this.$tip = this.root.querySelector(".axtip");
      this.$list = this.root.querySelector(".axis-list");
      this.pickupOpen = false; // 拾い出し結果は既定で閉じておく
      this.$pickupBody = this.root.querySelector(".pickup-body");
      this.$pickupToggle = this.root.querySelector(".pickup-toggle");
      this.$pickupSum = this.root.querySelector(".pickup-sum");
      this.$pickup = this.root.querySelector(".pickup-grid");
      this.$others = this.root.querySelector(".other-dims");
      this.$shGrid = this.root.querySelector(".sh-grid");
      this.$shOther = this.root.querySelector(".sh-other");
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
      for (const cb of [this.$shGrid, this.$shOther]) {
        cb.addEventListener("change", () => {
          this.renderPickup();
          this.requestRender(); // 図上の寸法オーバーレイも表示対象に合わせる
        });
      }
      this.$pickupToggle.addEventListener("click", () => this.setPickupOpen(!this.pickupOpen));
      this.$aiRun.addEventListener("click", () => this.runAi());
      this.$copy.addEventListener("click", () => {
        const txt = this.pickupText();
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
        // ページ数が少ない図面は、読み込んだ流れでそのまま分割を判定する。
        // 多ページ（構造図一式など）は時間がかかるのでボタンにする。
        if (this.pages.length >= 2) {
          if (this.pages.length <= SPLIT_AUTO_PAGES) await this.scanPages();
          else this.renderSplit();
        }
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
      this.glyphInfo = null;
      this.glyphPage = false;
      this.glyphMap = null;
      this.glyphTexts = [];
      this.baseTexts = null;
      this.pageSides = new Map(); // ページ番号(1始まり) → {page, sides, det}
      this.splitInfo = null;
      this.mergePages = false;
      this.diffRefs = null;
      if (this.$split) {
        this.$split.hidden = true;
        this.$split.innerHTML = "";
      }
      this.enabled.clear();
    }

    async loadPage(index) {
      if (!this.doc || !this.pages[index]) return;
      this.setStatus("解析中…");
      try {
        const ex = new ZC.content.ContentExtractor(this.doc);
        this.extract = await ex.run(this.pages[index]);
        this.baseTexts = this.extract.texts;
        // 線で描かれた文字（CADのストロークフォント）があれば、覚えている対応表で読む
        this.glyphInfo = null;
        // 文字が線で描かれた図面のときだけ、覚えている対応表を当てる
        // （通常の図面で重い字形解析を走らせないため）。
        // 読み取ったあとは outlined が false になりうるので、ページの種別は
        // 読み込み時に glyphPage として覚えておく。
        this.glyphPage = ZC.content.diagnose(this.extract).outlined;
        if (this.glyphPage) this.applyGlyphMap(loadGlyphMap(), true);
        const det = ZC.axis.detect(this.extract);
        this.det = det;
        this.axes = { v: det.v, h: det.h };
        this.enabled.clear();
        for (const ax of det.v.concat(det.h)) {
          if (ax.defaultOn) this.enabled.add(ax);
        }
        this.dimsInfo = ZC.dims.extract(this.extract);
        this.rebuildSides();
        this._remember(index, det, this.sides);
        if (this.splitInfo) this.renderSplit();
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
          this.diag = ZC.content.diagnose(this.extract, det, this.dimsInfo);
          const info =
            "符号の付いた通り芯: " + labeled + "本" +
            (det.plainLabels && det.plainLabels.length
              ? "（うち円で囲まれていない符号 " + det.plainLabels.join("・") + "）"
              : "") +
            "（縦" + det.v.filter((a) => a.label != null).length +
            " / 横" + det.h.filter((a) => a.label != null).length + "）" +
            " / 記載寸法 " + this.dimsInfo.entries.length + "区間を読取" +
            (this.extract.circles ? " / 符号バブル " + this.extract.circles.length + "個" : "");
          if (this.diag.outlined) {
            this.setStatus("このページには文字データがありません（数字が線で描かれています）／ " + info, "error");
          } else if (!this.diag.readable) {
            this.setStatus("この図面は読み取り条件を満たしていません（下の診断を参照）／ " + info, "error");
          } else {
            this.setStatus(info);
          }
        }
      } catch (e) {
        this.extract = null;
        this.axes = { v: [], h: [] };
        this.det = { v: [], h: [] };
        this.dimsInfo = { dots: [], entries: [] };
        this.sides = null;
        this.diag = null;
        this.setStatus("解析に失敗しました: " + (e && e.message ? e.message : e), "error");
      }
      if (!this.sides) this.others = null;
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

    // ---- 分割図面（1つの建物を上下/左右に分けて複数ページに描いたもの）--------

    // そのページの拾い出し結果を控える。芯には何ページ目のものかを付けておく
    // （まとめて照合したとき、図上の赤枠を「いま表示しているページ」のぶんだけ
    //   描くために要る。列挙不可なので JSON/CSV には出ない）
    _remember(index, det, sides) {
      if (!sides) return;
      for (const ax of (det.v || []).concat(det.h || [])) {
        Object.defineProperty(ax, "page", { value: index + 1, enumerable: false, configurable: true });
      }
      this.pageSides.set(index + 1, { page: index + 1, sides, det });
    }

    // 表示を切り替えずに1ページぶんだけ読む（分割の判定に使う）
    async _analyzePage(index) {
      const extract = await new ZC.content.ContentExtractor(this.doc).run(this.pages[index]);
      // 文字が線で描かれたページは、覚えている対応表を当ててから読む
      if (ZC.content.diagnose(extract).outlined) {
        const map = loadGlyphMap();
        if (map && Object.keys(map).length) {
          const info = ZC.glyph.extract(extract);
          extract.texts = extract.texts.concat(ZC.glyph.toTexts(info.runs, map));
        }
      }
      const det = ZC.axis.detect(extract);
      const dims = ZC.dims.extract(extract);
      const sides = ZC.sides.build(det, dims.entries);
      return { det, sides };
    }

    // 全ページを読んで「この図面は分割されているか」を判定する
    async scanPages() {
      if (!this.doc || this.pages.length < 2 || this.scanning) return;
      this.scanning = true;
      const keep = this.$status.textContent;
      try {
        for (let i = 0; i < this.pages.length; i++) {
          if (this.pageSides.has(i + 1)) continue;
          this.setStatus("分割の判定中… " + (i + 1) + " / " + this.pages.length + "ページ");
          const { det, sides } = await this._analyzePage(i);
          this._remember(i, det, sides);
        }
        const list = [...this.pageSides.values()].sort((a, b) => a.page - b.page);
        this.splitInfo = ZC.split.detect(list);
        // 分割されていると分かったら、既定でまとめて照合する
        if (this.splitInfo.split) this.mergePages = true;
      } finally {
        this.scanning = false;
        this.setStatus(keep);
        this.renderSplit();
        ZC.ui.updateRunButton();
      }
    }

    // 分割の判定結果を画面に出す
    renderSplit() {
      const box = this.$split;
      if (!box) return;
      box.innerHTML = "";
      if (!this.doc || this.pages.length < 2) {
        box.hidden = true;
        return;
      }
      box.hidden = false;
      const info = this.splitInfo;
      if (!info) {
        const btn = el("button", { type: "button", class: "split-scan", text: "全ページを調べて分割を判定" });
        btn.addEventListener("click", () => this.scanPages());
        box.appendChild(btn);
        box.appendChild(el("span", {
          class: "split-note",
          text: "この PDF は " + this.pages.length + " ページあります",
        }));
        return;
      }
      if (!info.split) {
        box.appendChild(el("span", {
          class: "split-note",
          text: "分割された図面ではないようです（" + info.reason + "）。ページを選んで照合してください。",
        }));
        return;
      }
      const dirName = info.dir === "h" ? "上下" : "左右";
      box.appendChild(el("div", {
        class: "split-title",
        text: "この図面は1つの建物を" + dirName + "に" + info.parts.length + "分割して描いています",
      }));
      const ul = el("div", { class: "split-parts" });
      for (const p of info.parts) {
        const last = p.labels[p.labels.length - 1];
        ul.appendChild(el("div", {
          class: "split-part" + (p.page === Number(this.$page.value || 0) + 1 ? " now" : ""),
          text: p.page + "ページ目 … " + p.labels[0] + " 〜 " + last + "（" + p.labels.length + "本）",
        }));
      }
      box.appendChild(ul);
      if (info.overlap.length) {
        box.appendChild(el("div", { class: "split-note", text: "ページの重なり: " + info.overlap.join(" ") }));
      }
      const lab = el("label", { class: "split-merge" });
      const cb = el("input", { type: "checkbox" });
      cb.checked = this.mergePages;
      cb.addEventListener("change", () => {
        this.mergePages = cb.checked;
        ZC.ui.updateRunButton();
      });
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(" 全ページをまとめて1つの図面として照合する"));
      box.appendChild(lab);
      const merged = this.mergedSides();
      if (merged && merged.conflicts && merged.conflicts.length) {
        box.appendChild(el("div", {
          class: "split-warn",
          text: "ページ間で記載寸法が食い違う区間があります: " +
            merged.conflicts.map((c) => c.name + " " + c.item + "（" + c.values.join(" / ") + "）").join(" , "),
        }));
      }
    }

    // 全ページをまとめた拾い出し結果（照合に使う）
    mergedSides() {
      if (!this.pageSides.size) return null;
      const list = [...this.pageSides.values()].sort((a, b) => a.page - b.page);
      if (list.length < 2) return list[0] ? list[0].sides : null;
      return ZC.split.merge(list);
    }

    // 照合に渡す拾い出し結果。分割をまとめる設定ならまとめたほうを返す
    compareSides() {
      if (this.mergePages && this.splitInfo && this.splitInfo.split) {
        const m = this.mergedSides();
        if (m) return m;
      }
      return this.sides;
    }

    // 照合結果（図上に色で描く）
    setDiffs(refs) {
      this.diffRefs = refs && refs.length ? refs : null;
      this.requestRender();
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
        if (this.localEmpty()) {
          this.renderAiOnly(data);
        } else {
          const tol = Number(document.getElementById("tol").value) || 1;
          this.renderAi(ZC.ai.diff(this.sides, this.aiSides, tol), data);
        }
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

    // 自動読み取りが1本も拾えていない図面（文字データ無しなど）では、
    // 「AIのみ」だらけの差分表ではなく、AIの結果そのものを拾い出し結果として出す。
    localEmpty() {
      if (!this.sides) return true;
      return !SIDE_ORDER.some((k) => this.sides[k] && this.sides[k].axes.length);
    }

    renderAiOnly(data) {
      const wrap = this.$aiResult;
      wrap.innerHTML = "";
      wrap.appendChild(
        el("div", {
          class: "ai-summary warn",
          text:
            "自動読み取りは0本のため、AIの読み取り結果を表示しています" +
            (data && data.model ? "（" + data.model + "）" : ""),
        })
      );
      const notes = data && data.result && data.result.notes;
      if (notes) wrap.appendChild(el("p", { class: "ai-msg", text: "AIの注記: " + notes }));
      wrap.appendChild(
        el("p", { class: "ai-msg", text: "AIの読み取りにも誤りがあります。数値は必ず図面でご確認ください。" })
      );
      const grid = el("div", { class: "pickup-grid" });
      renderSideBlocks(grid, this.aiSides);
      wrap.appendChild(grid);
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

    // 線で描かれた文字の情報を用意する（必要になったときだけ解析する）
    ensureGlyphInfo() {
      if (!this.glyphInfo && this.extract) this.glyphInfo = ZC.glyph.extract(this.extract);
      return this.glyphInfo;
    }

    // 形→文字の対応表を当てて、読み取った文字を extract.texts に足す。
    // quiet=true なら対応表が無いとき何もしない（読み込み時の自動適用）。
    applyGlyphMap(map, quiet) {
      if (!this.extract) return 0;
      this.glyphMap = map || null;
      const base = this.baseTexts || this.extract.texts;
      if (!map || !Object.keys(map).length) {
        this.extract.texts = base;
        this.glyphTexts = [];
        return 0;
      }
      const info = this.ensureGlyphInfo();
      this.glyphTexts = ZC.glyph.toTexts(info.runs, map);
      this.extract.texts = base.concat(this.glyphTexts);
      if (!quiet) this.reanalyze();
      return this.glyphTexts.length;
    }

    // texts を入れ替えたあとに検出からやり直す
    reanalyze() {
      const det = ZC.axis.detect(this.extract);
      this.det = det;
      this.axes = { v: det.v, h: det.h };
      this.enabled.clear();
      for (const ax of det.v.concat(det.h)) if (ax.defaultOn) this.enabled.add(ax);
      this.dimsInfo = ZC.dims.extract(this.extract);
      this.rebuildSides();
      this.diag = ZC.content.diagnose(this.extract, det, this.dimsInfo);
      const labeled = det.v.concat(det.h).filter((a) => a.label != null).length;
      this.setStatus(
        "線で描かれた文字から読み取りました: 通り芯 " + labeled + "本 / " +
          "記載寸法 " + this.dimsInfo.entries.length + "区間（文字列 " + this.glyphTexts.length + "件）",
        this.diag.readable ? "" : "error"
      );
      this.requestRender();
      this.renderList();
      this.renderPickup();
      ZC.ui.updateRunButton();
    }

    rebuildSides() {
      this.sides = ZC.sides.build(this.det, this.dimsInfo.entries, { enabled: this.enabled });
      // 芯のON/OFFで通り芯間に使う注記が変わるため、その他の寸法も作り直す
      this.others = ZC.sides.otherRows(this.sides, this.dimsInfo.entries);
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

      // 図面の線。PDF本来の線の太さを反映して太さごとに描き分ける
      // （全部同じ細さ・薄い色だと、寸法線や数字が白っぽく潰れて読めない）。
      // 最低でも1デバイスピクセルの太さを確保する。
      const minLw = Math.max(SEG_MIN_WIDTH, 1 / dpr);
      const lwOf = (w) => {
        const px = (w || 0.3) * v.scale;
        return Math.min(SEG_MAX_WIDTH, Math.max(minLw, px));
      };
      const buckets = new Map(); // 太さ(0.25刻み) → [ax,ay,bx,by,...]
      const segs = this.extract.segments;
      const maxDraw = 200000;
      for (let i = 0; i < segs.length && i < maxDraw; i++) {
        const s = segs[i];
        if (Math.max(s.x1, s.x2) < px0 - m || Math.min(s.x1, s.x2) > px1 + m) continue;
        if (Math.max(s.y1, s.y2) < py0 - m || Math.min(s.y1, s.y2) > py1 + m) continue;
        const a = this.toScreen(s.x1, s.y1);
        const b = this.toScreen(s.x2, s.y2);
        const key = Math.round(lwOf(s.w) * 4);
        let arr = buckets.get(key);
        if (!arr) buckets.set(key, (arr = []));
        arr.push(a[0], a[1], b[0], b[1]);
      }
      ctx.strokeStyle = COLORS.seg;
      for (const [key, arr] of buckets) {
        ctx.lineWidth = key / 4;
        ctx.beginPath();
        for (let i = 0; i < arr.length; i += 4) {
          ctx.moveTo(arr[i], arr[i + 1]);
          ctx.lineTo(arr[i + 2], arr[i + 3]);
        }
        ctx.stroke();
      }

      this._drawPdfTexts(ctx, px0, py0, px1, py1);
      this._drawHighlightBand(ctx);
      this._drawAxes(ctx);
      if (this.showDims) {
        if (!this.$shGrid || this.$shGrid.checked) this._drawDims(ctx);
        if (this.$shOther && this.$shOther.checked) this._drawOtherDims(ctx);
      }
      this._drawDiffBoxes(ctx); // 差異の赤枠は一番上に描く
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

    // 照合で差異が出た箇所を赤い枠で囲む。
    // 1本の芯だけの差異（相手の図面にその符号が無い）は芯そのものを、
    // 区間の差異（寸法が違う）はその2本のあいだを囲む。
    // まとめて照合しているときは、芯に付けた page で「いま見ているページ」の
    // ぶんだけ描く（別ページの芯は座標の意味が違うため）。
    // 照合結果の塗り用レイヤ（毎回作らず使い回す）。
    // **デバイスピクセルで持つ**こと。CSSピクセルで作ると本体へ重ねるときに
    // 拡大されてぼけるうえ、実図面で1描画が12msほど重くなる。
    _markLayer(w, h, dpr) {
      if (!w || !h) return null;
      let c = this._markCanvas;
      if (!c) c = this._markCanvas = document.createElement("canvas");
      const pw = Math.ceil(w * dpr);
      const ph = Math.ceil(h * dpr);
      if (c.width !== pw || c.height !== ph) {
        c.width = pw;
        c.height = ph;
      }
      const g = c.getContext("2d");
      if (!g) return null;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, pw, ph);
      g.setTransform(dpr, 0, 0, dpr, 0, 0); // 以降はCSSピクセルで描ける
      return g;
    }

    // 照合結果を図面に塗る。塗るのは**通り芯の符号と寸法の数字だけ**で、
    // 寸法線や通り芯の鎖線には色を付けない（図面が色で埋まって読めなくなるため）。
    //   左右（基準図面と比較図面）で同じ符号・同じ記載寸法 … 黄
    //   差異があった箇所                                   … 赤
    //   片方で寸法が読めなかった箇所                       … 橙
    // 一致 → 要確認 → 差異 の順に塗るので、重なっても差異が隠れない。
    _drawDiffBoxes(ctx) {
      const refs = this.diffRefs;
      if (!refs || !refs.length) return;
      const page = Number(this.$page.value || 0) + 1;
      // まとめて照合しているときは、いま見ているページのものだけを塗る
      // （別ページの芯・注記は座標の意味が違う）
      const mine = (o) => o && (o.page === undefined || o.page === page);
      const W = this.$canvas.clientWidth;
      const H = this.$canvas.clientHeight;

      // 符号（バブルまたは囲み無しの文字）1つぶんの矩形
      const bubbleRect = (b) => {
        const [cx, cy] = this.toScreen(b.x, b.y);
        const w = Math.max((b.w || 8) * this.view.scale, MARK_MIN_PX);
        const h = Math.max((b.h || 8) * this.view.scale, MARK_MIN_PX);
        return { x: cx - w / 2, y: cy - h / 2, w, h };
      };
      // 寸法の数字1つぶんの矩形（読んだ注記の文字の箱）
      const textRect = (t) => {
        const ex = t.ex !== undefined ? t.ex : t.x;
        const ey = t.ey !== undefined ? t.ey : t.y;
        const size = t.size || 7;
        const horiz = Math.abs(ex - t.x) >= Math.abs(ey - t.y);
        let x0 = Math.min(t.x, ex);
        let x1 = Math.max(t.x, ex);
        let y0 = Math.min(t.y, ey);
        let y1 = Math.max(t.y, ey);
        if (horiz) {
          y0 -= size * 0.2;
          y1 += size * 0.85;
          if (x1 - x0 < size * 0.6) x1 = x0 + size * 0.6;
        } else {
          x0 -= size * 0.85;
          x1 += size * 0.2;
          if (y1 - y0 < size * 0.6) y1 = y0 + size * 0.6;
        }
        const a = this.toScreen(x0, y1);
        const b2 = this.toScreen(x1, y0);
        const w = Math.max(b2[0] - a[0], MARK_MIN_PX);
        const h = Math.max(b2[1] - a[1], MARK_MIN_PX);
        return { x: a[0], y: a[1], w, h };
      };

      const byStatus = { OK: [], WARN: [], NG: [] };
      const seen = new Set();
      for (const d of refs) {
        const style = MARK_STYLE[d.status];
        if (!style) continue;
        const rects = [];
        // 区間の両端の符号
        for (const ax of d.axes || []) {
          if (!mine(ax)) continue;
          for (const b of ax.bubbles || []) rects.push(bubbleRect(b));
        }
        // その区間の寸法として読んだ数字
        const sp = d.span;
        if (sp && sp.entries && (!sp.fromAx || mine(sp.fromAx))) {
          for (const e of sp.entries) if (e && e.text) rects.push(textRect(e.text));
        }
        for (const r of rects) {
          const x = r.x - style.pad;
          const y = r.y - style.pad;
          const w = r.w + style.pad * 2;
          const h = r.h + style.pad * 2;
          if (x > W || y > H || x + w < 0 || y + h < 0) continue; // 画面外
          const key = d.status + ":" + Math.round(x) + "," + Math.round(y) + "," + Math.round(w);
          if (seen.has(key)) continue;
          seen.add(key);
          byStatus[d.status].push({ x, y, w, h, label: d.label, status: d.status });
        }
      }
      const all = MARK_ORDER.reduce((n, k) => n + byStatus[k].length, 0);
      if (!all) return;
      ctx.save();
      // 塗り: 別レイヤに不透明で描いてから、まとめて薄く重ねる。
      // 符号と数字が隣り合って重なっても、色が二重に濃くならないようにするため。
      const dpr = globalThis.devicePixelRatio || 1;
      const lay = this._markLayer(W, H, dpr);
      if (lay) {
        for (const st of MARK_ORDER) {
          lay.fillStyle = MARK_STYLE[st].fill;
          for (const bx of byStatus[st]) lay.fillRect(bx.x, bx.y, bx.w, bx.h);
        }
        const tf = ctx.getTransform ? ctx.getTransform() : null;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = MARK_ALPHA;
        ctx.drawImage(lay.canvas, 0, 0);
        ctx.globalAlpha = 1;
        if (tf) ctx.setTransform(tf);
        else ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      // 差異は一致より濃くする（同じ色を薄く重ねるので色は濁らない）
      for (const st of ["WARN", "NG"]) {
        const style = MARK_STYLE[st];
        ctx.globalAlpha = style.extra;
        ctx.fillStyle = style.fill;
        for (const bx of byStatus[st]) ctx.fillRect(bx.x, bx.y, bx.w, bx.h);
      }
      ctx.globalAlpha = 1;
      // 枠は差異のぶんだけ（一致は塗りだけで十分）
      for (const st of ["WARN", "NG"]) {
        const style = MARK_STYLE[st];
        ctx.strokeStyle = style.line;
        ctx.lineWidth = style.width;
        ctx.setLineDash(style.dash);
        for (const bx of byStatus[st]) ctx.strokeRect(bx.x, bx.y, bx.w, bx.h);
      }
      ctx.setLineDash([]);
      // 見出しは NG のぶんだけ。重なったらずらし、それでも重なるなら出さない
      ctx.font = "bold 11px sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const placed = [];
      const hit = (r) =>
        placed.some((q) => r.x < q.x + q.w + 2 && q.x < r.x + r.w + 2 && r.y < q.y + q.h + 1 && q.y < r.y + r.h + 1);
      const labelled = byStatus.NG.filter((b) => b.label);
      for (const bx of labelled.sort((p1, p2) => p1.x - p2.x || p1.y - p2.y)) {
        const tw = ctx.measureText(bx.label).width + 8;
        const th = 14;
        const r = { x: Math.min(Math.max(bx.x, 0), Math.max(W - tw, 0)), y: bx.y - th - 1, w: tw, h: th };
        for (let i = 0; i < 12 && (hit(r) || r.y < 0); i++) r.y = r.y < 0 ? bx.y + bx.h + 1 + i * (th + 1) : r.y - (th + 1);
        if (hit(r)) continue;
        placed.push(r);
        ctx.fillStyle = MARK_STYLE[bx.status].line;
        ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.fillStyle = "#fff";
        ctx.fillText(bx.label, r.x + 4, r.y + th / 2 + 0.5);
      }
      ctx.restore();
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
    // PDFに入っている文字（寸法の数字・室名など）を図面上のその位置に描く。
    // これが無いと、線だけの図面に見えて「図面に寸法が書かれていない」ように
    // 見えてしまう（実際には元のPDFに文字として入っている）。
    // 線で描かれた文字（glyphText）は線として既に描かれているので除く。
    _drawPdfTexts(ctx, px0, py0, px1, py1) {
      const texts = (this.extract && this.extract.texts) || [];
      if (!texts.length) return;
      const v = this.view;
      ctx.fillStyle = COLORS.seg;
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      for (const t of texts) {
        if (t.glyphText) continue;
        const tex = t.ex !== undefined ? t.ex : t.x;
        const tey = t.ey !== undefined ? t.ey : t.y;
        const size = t.size || 10;
        if (Math.max(t.x, tex) < px0 - size || Math.min(t.x, tex) > px1 + size) continue;
        if (Math.max(t.y, tey) < py0 - size || Math.min(t.y, tey) > py1 + size) continue;
        const px = size * v.scale;
        if (px < TEXT_MIN_PX) continue; // 小さすぎると潰れるだけなので描かない
        const a = this.toScreen(t.x, t.y);
        const b = this.toScreen(tex, tey);
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const adv = Math.hypot(dx, dy);
        ctx.save();
        ctx.font = px.toFixed(2) + "px sans-serif"; // save/restore で戻るので毎回入れる
        ctx.translate(a[0], a[1]);
        if (Math.abs(dy) > 0.01 || dx < 0) ctx.rotate(Math.atan2(dy, dx));
        // 元の文字送りに合わせて横に伸縮する（CADの文字幅に近づける）
        if (adv > 1) {
          const w = ctx.measureText(t.str).width;
          if (w > 1) ctx.scale(adv / w, 1);
        }
        ctx.fillText(t.str, 0, 0);
        ctx.restore();
      }
    }

    // 通り芯以外の寸法線を、図面上のその位置に描く（拡大時のみ数値を出す）
    _drawOtherDims(ctx) {
      if (!this.others) return;
      ctx.font = "10px sans-serif";
      ctx.strokeStyle = COLORS.other;
      ctx.fillStyle = COLORS.other;
      ctx.lineWidth = 1;
      const W = this.$canvas.clientWidth;
      const H = this.$canvas.clientHeight;
      for (const dir of ["v", "h"]) {
        for (const r of this.others[dir]) {
          if (dir === "v") {
            const [, y] = this.toScreen(0, r.row);
            if (y < -20 || y > H + 20) continue;
            const [x1] = this.toScreen(r.from, 0);
            const [x2] = this.toScreen(r.to, 0);
            if (x2 - x1 < 8 || x2 < -20 || x1 > W + 20) continue;
            ctx.beginPath();
            ctx.moveTo(x1, y);
            ctx.lineTo(x2, y);
            for (const e of r.items) {
              const [px] = this.toScreen(e.p1, 0);
              ctx.moveTo(px, y - 3);
              ctx.lineTo(px, y + 3);
            }
            ctx.moveTo(x2, y - 3);
            ctx.lineTo(x2, y + 3);
            ctx.stroke();
            ctx.textAlign = "center";
            for (const e of r.items) {
              const [a] = this.toScreen(e.p1, 0);
              const [b] = this.toScreen(e.p2, 0);
              if (b - a < 26) continue;
              haloText(ctx, ZC.sides.fmtVal(e.value), (a + b) / 2, y - 3);
            }
          } else {
            const [x] = this.toScreen(r.row, 0);
            if (x < -20 || x > W + 20) continue;
            const [, y1] = this.toScreen(0, r.from);
            const [, y2] = this.toScreen(0, r.to);
            if (y1 - y2 < 8 || y1 < -20 || y2 > H + 20) continue;
            ctx.beginPath();
            ctx.moveTo(x, y1);
            ctx.lineTo(x, y2);
            for (const e of r.items) {
              const [, py] = this.toScreen(0, e.p1);
              ctx.moveTo(x - 3, py);
              ctx.lineTo(x + 3, py);
            }
            ctx.moveTo(x - 3, y2);
            ctx.lineTo(x + 3, y2);
            ctx.stroke();
            for (const e of r.items) {
              const [, a] = this.toScreen(0, e.p1);
              const [, b] = this.toScreen(0, e.p2);
              if (a - b < 26) continue;
              ctx.save();
              ctx.translate(x - 3, (a + b) / 2);
              ctx.rotate(-Math.PI / 2);
              ctx.textAlign = "center";
              haloText(ctx, ZC.sides.fmtVal(e.value), 0, 0);
              ctx.restore();
            }
          }
        }
      }
    }

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

    // コピー用テキスト（表示チェックに合わせる）
    pickupText() {
      const out = [];
      if ((!this.$shGrid || this.$shGrid.checked) && this.sides) out.push(ZC.sides.formatText(this.sides));
      if (this.$shOther && this.$shOther.checked && this.others) {
        for (const g of [
          { title: "X方向の寸法線（横向き）", rows: this.others.v },
          { title: "Y方向の寸法線（縦向き）", rows: this.others.h },
        ]) {
          out.push("■その他の寸法 " + g.title + "（" + g.rows.length + "段）");
          for (const r of g.rows) out.push(ZC.sides.formatRow(r));
          out.push("");
        }
      }
      return out.join("\n").trim();
    }

    // 拾い出し結果の開閉
    setPickupOpen(on) {
      this.pickupOpen = !!on;
      if (!this.$pickupBody) return;
      this.$pickupBody.hidden = !this.pickupOpen;
      this.$pickupToggle.setAttribute("aria-expanded", this.pickupOpen ? "true" : "false");
      this.$pickupToggle.classList.toggle("open", this.pickupOpen);
    }

    // 閉じていても中身が分かるよう、見出しの横に要約を出す
    pickupSummary() {
      if (!this.extract) return "";
      if (this.diag && !this.diag.readable) return "この図面からは拾い出しできません";
      if (!this.sides) return "";
      let spans = 0;
      let read = 0;
      for (const k of SIDE_ORDER) {
        const s = this.sides[k];
        if (!s) continue;
        spans += s.spans.length;
        read += s.spans.filter((x) => x.value != null).length;
      }
      if (!spans) return "通り芯 " + this.labeledAxes().length + "本";
      return "通り芯 " + this.labeledAxes().length + "本 / 区間 " + spans +
        "（寸法が読めたもの " + read + "）";
    }

    renderPickup() {
      const showGrid = !this.$shGrid || this.$shGrid.checked;
      const showOther = this.$shOther && this.$shOther.checked;
      if (this.$pickupSum) this.$pickupSum.textContent = this.pickupSummary();
      // 読み取り条件を満たしていない図面は、黙って0件にせず何が足りないかを出す。
      if (this.diag && !this.diag.readable) {
        this.$pickup.hidden = false;
        this.$others.hidden = true;
        this.$others.innerHTML = "";
        this.$pickup.innerHTML = "";
        this.$pickup.appendChild(renderDiagnosis(this.diag, this));
        // 読めない理由は見てもらわないと困るので、このときだけ開く
        this.setPickupOpen(true);
        return;
      }
      this.$pickup.hidden = !showGrid;
      if (showGrid) renderSideBlocks(this.$pickup, this.sides);
      else this.$pickup.innerHTML = "";
      // 線で描かれた文字の図面では、読めていても字形を足せるようにしておく
      if (showGrid && (this.glyphPage || (this.diag && this.diag.outlined))) {
        this.$pickup.appendChild(glyphTeachBar(this, "線で描かれた文字を教える・追加する"));
      }
      this.$others.hidden = !showOther;
      if (showOther) renderOtherDims(this.$others, this.others);
      else this.$others.innerHTML = "";
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
      const marks = document.getElementById("ck-marks");
      if (marks) marks.addEventListener("change", () => ui.showDiffMarks(ui.lastResult));
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
      // 表示中の設定で照合し直したときに赤枠も追従させる
      if (ui.lastResult) ui.showDiffMarks(ui.lastResult);
    },

    runCheck() {
      const tol = Number(document.getElementById("tol").value) || 1;
      const checks = {
        labels: document.getElementById("ck-labels").checked,
        spacing: document.getElementById("ck-spacing").checked,
        total: document.getElementById("ck-total").checked,
      };
      const unitSel = document.getElementById("cmp-unit");
      const byDir = unitSel && unitSel.value === "dir";
      // 分割されたページはまとめ、「方向ごと」なら上辺+下辺・右辺+左辺もまとめる
      const sidesOf = (panel) => {
        const s = panel.compareSides();
        return byDir && s ? ZC.split.byDirection(s) : s;
      };
      const result = ZC.compare.compare(
        { sides: sidesOf(ui.base), name: "基準" },
        { sides: sidesOf(ui.cmp), name: "比較" },
        { tol, checks }
      );
      ui.lastResult = result;
      ui.renderResult(result, tol);
      ui.showDiffMarks(result);
    },

    // 照合結果を両方のビュワーに色で出す（一致=黄 / 差異=赤 / 要確認=橙）
    showDiffMarks(result) {
      const on = document.getElementById("ck-marks");
      if (!on || !on.checked || !result) {
        ui.base.setDiffs(null);
        ui.cmp.setDiffs(null);
        return;
      }
      const b = [];
      const c = [];
      for (const r of result.rows) {
        // 図面全体にかかる行（符号の一覧・全体寸法）で塗ると図面が丸ごと埋まる
        if (!r.refs || r.scope === "all") continue;
        const label = r.item;
        if (r.refs.b && r.refs.b.length) b.push({ axes: r.refs.b, span: r.refs.bs, label, status: r.status });
        if (r.refs.c && r.refs.c.length) c.push({ axes: r.refs.c, span: r.refs.cs, label, status: r.status });
      }
      ui.base.setDiffs(b);
      ui.cmp.setDiffs(c);
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
      // 図面に付く色の凡例
      const legend = el("p", { class: "result-hint legend" });
      legend.appendChild(document.createTextNode("図面の色: "));
      for (const [cls, label] of [
        ["ok", "一致（左右で同じ通り芯・同じ記載寸法）"],
        ["ng", "差異（記載寸法が違う / 片方にしか無い通り芯）"],
        ["warn", "要確認（片方で寸法が読めない）"],
      ]) {
        const sw = el("span", { class: "legend-item" });
        sw.appendChild(el("span", { class: "legend-sw " + cls }));
        sw.appendChild(document.createTextNode(label));
        legend.appendChild(sw);
      }
      wrap.appendChild(legend);
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
