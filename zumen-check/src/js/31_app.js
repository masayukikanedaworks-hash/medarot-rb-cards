// 起動: ブラウザ上でのみ UI を初期化する（Node のテスト実行では何もしない）
(function (ZC) {
  "use strict";
  if (typeof document === "undefined" || !document.getElementById) return;
  const boot = () => {
    if (document.getElementById("panel-base-body")) ZC.ui.init();
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})(globalThis.ZC = globalThis.ZC || {});
