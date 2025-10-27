// backend-vercel/api/generate.js
// 他の箇所は絶対に変えず、以下の点だけ修正：
// 1) フロントの「短め/長め」ボタンと連携（body.length に "short"/"long" が来たら従う。来ない場合は word に含めた注記も検出）
// 2) 使うAPIを Grok-4（x.ai）に変更（XAI_API_KEY / XAI_MODEL）
// 3) OpenAI専用パラメータを削除し、JSON返却はプロンプトで厳格指示

export const config = { runtime: "edge" };

// ★ Grok（x.ai）用
const XAI_API_KEY = process.env.XAI_API_KEY || "";
const XAI_MODEL   = process.env.XAI_MODEL || "grok-4-fast-reasoning";

export default async function handler(req) {
  try {
    if (req.method !== "POST") {
      return json({ error: "Only POST" }, 405);
    }
    const body = await req.json().catch(() => ({}));
    const rawWord = String(body?.word ?? "").trim();
    if (!rawWord) return json({ error: "word is required" }, 400);

    // ★ 長さモードの決定（button から body.length / "short"|"long"）
    //    互換のため、word に "(短め" / "(長め" が含まれていたらそれも解釈
    let lengthMode = String(body?.length ?? "").toLowerCase(); // "short" | "long" | ""
    if (!lengthMode) {
      if (/\(短め/.test(rawWord)) lengthMode = "short";
      else if (/\(長め/.test(rawWord)) lengthMode = "long";
    }
    if (lengthMode !== "short" && lengthMode !== "long") {
      lengthMode = "short"; // デフォルトは短め
    }

    // 実際にモデルへ渡す「言葉」から、表示用注記は取り除く
    const word = rawWord.replace(/\s*\((短め|長め)[^)]+\)\s*$/,'').trim();

    if (!XAI_API_KEY) {
      // キー未設定でも落ちない保険
      return json(localFallback(word));
    }

    // ★ 長さ制約を動的に切り替え
    const lengthRule = lengthMode === "short"
      ? "短め（10〜30文字）"
      : "長め（31〜60文字）";

    // プロンプト（JSONのみ返答するよう厳格指示）
    const systemMsg =
      "You are a Japanese satirist who writes one-line barbed satire. " +
      "Tone: sharp, acerbic, wry, economical. Use reversal, contradiction, and bite. " +
      "Avoid hate speech, slurs, doxxing, or explicit personal attacks on private individuals. " +
      "Never mention specific living persons or companies unless the user explicitly provided the term. " +
      "Return JSON only.";

    const userMsg =
      `次の「言葉」について、${lengthRule}の**辛辣で痛烈な風刺/皮肉**を日本語で出力してください。
必ず次のJSONのみを返答してください（前後に何も書かない）:
{"satire":"…","type":"…"}
- "satire": 一行（句点は任意、固有名は一般語に言い換え）
- "type": 社会風刺/仕事風刺/恋愛風刺/テクノロジー風刺 など
言葉: ${word}`;

    // ★ x.ai Grok-4 へ切替
    const r = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${XAI_API_KEY}`
      },
      body: JSON.stringify({
        model: XAI_MODEL,
        messages: [
          { role: "system", content: systemMsg },
          { role: "user",   content: userMsg }
        ]
        // temperature などはモデル仕様に合わせ未指定（デフォルト）
      })
    });

    if (!r.ok) {
      const text = await r.text();
      // 失敗時も何か返す
      return json({ ...localFallback(word), error: `Grok ${r.status}: ${text}` });
    }

    const data = await r.json();
    const content = data?.choices?.[0]?.message?.content ?? "{}";

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = {};
    }
    const satire = String(parsed?.satire ?? "").trim();
    const type   = String(parsed?.type   ?? "社会風刺").trim();

    // 念のための保険
    if (!satire) {
      return json(localFallback(word));
    }

    return json({ satire, type });
  } catch (e) {
    return json({ ...localFallback(""), error: String(e?.message || e) }, 200);
  }
}

function localFallback(w) {
  const word = String(w || "").trim();
  let satire;
  if (!word) satire = "空白：一番誤魔化しやすい答え。";
  else if (word.toLowerCase().includes("ai")) satire = "人間がサボる理由を自動生成。";
  else if (word.includes("上司")) satire = "責任を部下にクラウド化。";
  else if (word.includes("お金")) satire = "幸福の代わりに数えやすさをくれる。";
  else satire = "期待と現実のスキマで増殖する言い訳。";

  let type = "社会風刺";
  if (word.toLowerCase().includes("ai")) type = "テクノロジー風刺";
  else if (word.includes("上司")) type = "仕事風刺";
  else if (word.includes("恋") || word.includes("愛")) type = "恋愛風刺";

  return { satire, type };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}