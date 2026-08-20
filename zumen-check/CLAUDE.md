# 通り芯照合ツール 開発メモ

基準図面と比較図面（ベクター PDF）から通り芯と芯々寸法を抽出して照合する、
単一 HTML で完結するブラウザアプリ。概要と使い方は [README.md](./README.md)。

## コマンド

```bash
npm test          # 回帰テスト（Node 18+ / 外部依存なし）
npm run build     # dist/zumen-check.html を再生成
```

コミット前に必ず両方を実行し、`dist/zumen-check.html` も一緒にコミットする
（利用者はビルドせずに dist を直接開くため）。

## 構成

```
src/template.html   HTML/CSS の器。<!--@SCRIPTS--> が連結JSに置換される
src/js/_order.json  連結順（ビルドとテストの両方が参照する唯一の定義）
src/js/00_ns.js     名前空間 ZC
src/js/01_util.js   文字正規化・行列・共通ヘルパ
src/js/10_filters.js  FlateDecode（DecompressionStream使用）・予測子・各種フィルタ
src/js/11_lexer.js  PDF構文の字句解析とオブジェクト組み立て
src/js/12_pdf.js    xref（表/ストリーム）・ObjStm・ページ列挙・ストリーム復号
src/js/13_fonts.js  ToUnicode CMap / 単純エンコーディング / 字幅
src/js/14_content.js  コンテントストリーム解釈 → 線分・テキスト抽出
src/js/20_axis.js   通り芯検出（クラスタリング・鎖線連結・符号割り当て）
src/js/21_scale.js  寸法注記からの縮尺推定
src/js/22_compare.js  2図面の照合（符号・芯々寸法・全体寸法・寸法値整合）
src/js/30_ui.js     UI（DOMを触るのはここと31のみ）
src/js/31_app.js    起動（ブラウザ判定）
tools/build.js      連結ビルド
tools/inspect.js    検査CLI（取り込み・測定・照合をターミナルで確認。npm run inspect）
test/run.js         連結ソースをグローバルに eval してから *.test.js を実行
test/make_pdf.js    テスト用の合成ベクターPDF生成器（2系統のPDF構造）
```

## コーディング規約

- **import/export 禁止**。ファイルは `_order.json` の順に連結されるため、
  各ファイルは `(function (ZC) { ... })(globalThis.ZC = globalThis.ZC || {})`
  で名前空間 `ZC` にぶら下げる。
- 実行時依存・CDN・fetch は追加しない（オフライン動作と「外部送信しない」が要件）。
- ビルド時依存も追加しない（Node 標準モジュールのみ）。
- DOM 操作は `30_ui.js` / `31_app.js` に閉じ込める。それ以外のモジュールは
  Node のテストから直接呼べる純粋ロジックに保つ。
- 単位はコメントが無い限り pt（1/72 インチ）。実寸 mm への換算は
  `mm = pt × (縮尺分母 / 2.83465)`（`ZC.scale.mmPerPtFromDen` を使う）。

## 座標系

- 抽出結果はすべて「表示向き」のデバイス座標（y 上向き・pt）。
  ページの `/MediaBox`(`/CropBox`) 原点補正と `/Rotate`(90/180/270) の回転は
  `14_content.js` の run() が吸収する。以降の層は回転を意識しない。
- Canvas 描画時のみ y を反転する（`30_ui.js`）。

## 通り芯検出の考え方（20_axis.js）

1. 軸平行（縦/横）の線分を位置でクラスタリング（`CLUSTER_TOL` = 0.35pt）。
2. 同一クラスタ内の区間を `GAP_TOL`(14pt) 以内の切れ目で連結し、最長チェーンを採用。
   一点鎖線は「d パターン付きの1本線」でも「短い線分の連なり」でも出力されるため、
   後者は本数とカバー率（`CHAIN_*`）で鎖線相当と判定する。
3. 長さが `max(MIN_LEN_ABS, MIN_LEN_RATIO × 内容範囲)` 未満は捨てる。
4. 符号ラベル（X1/Y2/A/12 等。3桁以上の純数字は寸法値として除外）を
   端点近傍（`LABEL_RADIUS`）から貪欲法で割り当てる。全角は半角へ正規化。
5. **既定でチェックONになるのは「符号あり or 鎖線」かつ「図枠疑いでない」もの**。
   壁線・寸法線・図枠などの誤検出候補は一覧に出しつつ既定OFFにして、
   利用者がチェックボックスで最終判断する（README の仕様）。

しきい値はすべて `ZC.axis.PARAMS` に集約。実図面で調整するときはここを触り、
必ず `test/make_pdf.js` に再現ケースを足してから変える。

## 縮尺推定（21_scale.js）

隣接する芯ペアの中央付近（`MID_RATIO`）にある 3〜5 桁の数値注記を
候補として `mm/pt` を計算し、相対差 2.5% 以内の最大クラスタの中央値を採用。
1/10〜1/1200 の標準縮尺に 2% 以内で一致すればスナップする。
推定不能時は UI で手入力（既定 1/100）。**縮尺が違う 2 図面でも実寸 mm に
換算して照合する**ので、照合は縮尺に依存しない。

## 照合（22_compare.js）

- 対応付けは符号一致を優先し、残りは実寸位置（符号一致ペアの中央値オフセットで
  補正、`MATCH_TOL_MM` = 25mm）で対応させる。位置対応したが符号が異なるペアは
  「符号 NG」として報告（例: Y2 ↔ Y3）。
- チェック項目: 符号の対応 / 芯々寸法（隣接ペア） / 全体寸法（両端） /
  寸法値整合（各図面内で注記寸法と作図距離を比較）。
- 判定は `|差| ≤ 許容差(mm)`。既定 1mm。

## ビュワー（30_ui.js の Panel）

- ページ座標(pt, y上向き) ⇔ 画面座標の変換は `toScreen()/toPage()` に集約。
  ビュー状態は `panel.view = {scale, ox, oy, fitScale}`（null なら次描画でフィット）。
- 描画は `requestRender()`（rAFで間引き）経由で呼ぶ。直接 `renderCanvas()` を
  呼ぶのは初期化時のみ。可視範囲外の線分はカリングして描かない。
- 操作: ホイール=ズーム / ドラッグ=パン / ダブルクリック=フィット /
  芯クリック=照合ON/OFF（`_hitAxis` は画面座標で6px以内） /
  測定モード=2点間距離（`_snap` が芯位置と線分端点へスナップ、Escで解除）。
- 寸法オーバーレイ（`_drawDims`）はチェック中の芯だけを対象に、縦芯は上側・
  横芯は左側へ寸法線と mm 値を描く。区間が画面上34px未満なら数値を省略。
- 照合結果の行は `row.refs = {b:[芯...], c:[芯...]}`（列挙不可プロパティ）を持ち、
  行ホバーで両パネルの `setHighlight()` を呼んで該当箇所を強調する。
  refs は enumerable:false なので JSON/CSV には出ない（テストで担保）。

## PDF パーサの対応範囲と既知の制限

対応: クラシック xref・xref ストリーム（PNG 予測子）・ObjStm・ハイブリッド参照・
FlateDecode/ASCIIHex/ASCII85/RunLength・Form XObject（再帰8段まで）・
インライン画像の読み飛ばし・Type1/TrueType（WinAnsi/Differences）・
Type0 Identity-H + ToUnicode・TJ/Tj/'/" と全テキスト行列・xref 破損時の全走査復旧。

非対応（明示エラーまたは無視）:

- 暗号化 PDF → 読み込み時に日本語エラー
- LZW / 画像系フィルタのコンテント → そのストリームだけスキップ
- Type3 フォントの FontMatrix、縦書き（Identity-V）
- OCG（レイヤ）の表示状態 → 非表示レイヤも抽出対象になる
- 塗り（f）のみの図形 → 線分にしない（ハッチング対策）。輪郭が塗りだけの
  通り芯は検出できない

## 落とし穴メモ

- `DecompressionStream("deflate")` は末尾ゴミで例外を投げる実装がある。
  `10_filters.js` の inflate は 3 段フォールバックを持つ。順序を変えないこと。
- CAD からの出力は一点鎖線を数百の微小線分に分解することがある。
  `MIN_PIECE_LEN` を上げすぎると鎖線の破片を拾えなくなる。
- 通り芯符号は全角（Ｘ１）で入っていることがある。比較は必ず
  `ZC.util.normalizeLabel` を通す。
- 芯の絶対位置は図面ごとに原点が違うため意味を持たない。照合は必ず
  「差分（芯々・全体）」で行う。オフセット合わせは matchAxes 内のみ。
- テストは連結後のソースを `(0, eval)` で読み込む。つまり **テストが通る =
  連結順が正しい** ことの検証を兼ねる。`_order.json` を変えたら必ず npm test。

## テスト方針

実 PDF はリポジトリに置かない（図面は顧客資産のため）。代わりに
`test/make_pdf.js` が通り芯・壁二重線・寸法線・図枠・ノイズ・バブル円を含む
合成図面を 2 系統の PDF 構造（クラシック xref / xref ストリーム+ObjStm+Type0）で
生成し、検出→縮尺推定→照合の全経路を回す。不具合を直すときは、まず
make_pdf.js のパラメータで再現ケースを作ってから直すこと。
