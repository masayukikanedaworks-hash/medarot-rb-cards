// 通り芯照合ツールのAI解析エンドポイント（Vercel サーバレス関数）
//
// ブラウザから PDF（base64）とページ番号を受け取り、Claude に図面を読ませて
// 上辺・右辺・下辺・左辺ごとの通り芯と記載寸法を返す。
// APIキーはこのサーバ側の環境変数 ANTHROPIC_API_KEY にのみ置き、ブラウザには渡さない。
"use strict";

const Anthropic = require("@anthropic-ai/sdk");

const MODEL = "claude-opus-5";
const MAX_PDF_BYTES = 3.5 * 1024 * 1024; // Vercel のリクエスト上限(4.5MB)に対する余裕を見た値

// 出力スキーマ: ツールの拾い出し結果と同じ形にそろえる
const SPAN = {
  type: "object",
  properties: {
    from: { type: "string", description: "区間の始まりの通り芯符号（例 X1）" },
    to: { type: "string", description: "区間の終わりの通り芯符号（例 X2）" },
    value: {
      type: ["number", "null"],
      description: "図面に記載された芯々寸法(mm)。分割記載なら合計。記載が無ければ null",
    },
    parts: {
      type: "array",
      items: { type: "number" },
      description: "分割記載されている場合の内訳(mm)。分割が無ければ空配列",
    },
  },
  required: ["from", "to", "value", "parts"],
  additionalProperties: false,
};

const SIDE = {
  type: "object",
  properties: {
    axes: {
      type: "array",
      items: { type: "string" },
      description: "その辺に符号がある通り芯を、図面上の並び順に並べたもの",
    },
    spans: { type: "array", items: SPAN, description: "隣り合う通り芯の間の記載寸法" },
  },
  required: ["axes", "spans"],
  additionalProperties: false,
};

const SCHEMA = {
  type: "object",
  properties: {
    sides: {
      type: "object",
      properties: { top: SIDE, right: SIDE, bottom: SIDE, left: SIDE },
      required: ["top", "right", "bottom", "left"],
      additionalProperties: false,
    },
    notes: {
      type: "string",
      description: "読み取れなかった箇所や判断に迷った箇所があれば簡潔に。無ければ空文字",
    },
  },
  required: ["sides", "notes"],
  additionalProperties: false,
};

const SYSTEM = `あなたは建築図面を読む専門家です。渡された平面図から、通り芯と芯々寸法を正確に拾い出してください。

拾い出しのルール（厳守）:
1. 通り芯は「円（バブル）で囲まれた X○○ / Y○○」の符号があるものだけを対象にします。
   縦方向（X方向）は X1, X2, X2.2 ... 、横方向（Y方向）は Y1, Y2, Y4.7 ... です。
   X2.2 や Y4.7 のような小数点付きの符号も必ず拾ってください。
   円で囲まれていない文字、符号のない線、部屋名や記号は通り芯ではありません。
2. 図面の上辺・右辺・下辺・左辺のそれぞれについて、その辺に符号が書かれている通り芯を
   図面上の並び順（上辺・下辺は左→右、右辺・左辺は下→上）に並べてください。
   同じ通り芯が複数の辺に書かれていることも、片方の辺にしか無いこともあります。
3. 寸法は図面に「記載されている数字」をそのまま読み取ります。図の長さを測ってはいけません。
   縮尺は使いません。寸法線は黒い点（ドット）の間に引かれた直線で、その線の上（縦の寸法線は左側）に
   数字が書かれています。小数点付きの寸法（2730.5 など）もそのまま読んでください。
4. 通り芯の間が複数に分割して記載されている場合は、合計を value に、内訳を parts に入れてください。
   分割が無ければ parts は空配列です。
5. その辺にその区間の寸法が記載されていない場合は value を null にしてください。
   推測して数字を入れてはいけません。壁面基準など通り芯間ではない寸法は使わないでください。

見えない・判断できない場合は空欄（null や空配列）にし、notes に理由を書いてください。`;

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST のみ受け付けます" });
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({
      error: "サーバに ANTHROPIC_API_KEY が設定されていません。Vercel の環境変数に設定してください。",
    });
    return;
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const pdfBase64 = body.pdfBase64;
    const page = Number(body.page) || 1;
    if (!pdfBase64 || typeof pdfBase64 !== "string") {
      res.status(400).json({ error: "pdfBase64 がありません" });
      return;
    }
    const approxBytes = Math.floor((pdfBase64.length * 3) / 4);
    if (approxBytes > MAX_PDF_BYTES) {
      res.status(413).json({
        error:
          `PDFが大きすぎます（約${(approxBytes / 1024 / 1024).toFixed(1)}MB）。` +
          `${(MAX_PDF_BYTES / 1024 / 1024).toFixed(1)}MB以下に分割してからお試しください。`,
      });
      return;
    }

    const client = new Anthropic();
    const request = {
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      thinking: { type: "adaptive" },
      output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA } },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: pdfBase64 },
            },
            {
              type: "text",
              text:
                `このPDFの ${page} ページ目の平面図について、上辺・右辺・下辺・左辺の` +
                `通り芯（円で囲まれた X○○ / Y○○）と、その辺に記載されている芯々寸法を拾い出してください。`,
            },
          ],
        },
      ],
    };

    let response;
    try {
      // 安全性判定で拒否された場合に同一リクエストを別モデルで継続させる（サーバ側フォールバック）
      response = await client.beta.messages.create({
        ...request,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
    } catch (e) {
      if (e instanceof Anthropic.BadRequestError) {
        // フォールバック指定が使えない環境では通常リクエストで実行する
        response = await client.messages.create(request);
      } else {
        throw e;
      }
    }

    if (response.stop_reason === "refusal") {
      res.status(422).json({
        error: "モデルが応答を拒否しました",
        detail: response.stop_details || null,
      });
      return;
    }

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    let result;
    try {
      result = JSON.parse(text);
    } catch (e) {
      res.status(502).json({ error: "AIの応答を解釈できませんでした", raw: text.slice(0, 2000) });
      return;
    }

    res.status(200).json({
      model: response.model,
      page,
      result,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      },
    });
  } catch (e) {
    const status = e && e.status ? e.status : 500;
    const map = {
      401: "APIキーが正しくありません",
      429: "APIのレート上限に達しました。しばらく待って再実行してください",
    };
    res.status(status >= 400 && status < 600 ? status : 500).json({
      error: map[status] || (e && e.message ? e.message : "AI解析に失敗しました"),
    });
  }
};
