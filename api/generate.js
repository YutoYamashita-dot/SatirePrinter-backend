// backend-vercel/api/generate.js
export const config = { runtime: "edge" };

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL   = process.env.OPENAI_MODEL || "gpt-5";

export default async function handler(req) {
  try {
    if (req.method !== "POST") {
      return json({ error: "Only POST" }, 405);
    }
    const body = await req.json().catch(() => ({}));
    const word = String(body?.word ?? "").trim();
    if (!word) return json({ error: "word is required" }, 400);

    if (!OPENAI_API_KEY) {
      // キー未設定でも落ちない保険
      return json(localFallback(word));
    }

    const prompt = {
      role: "user",
      content:
        `次の言葉に対する風刺/皮肉を「1行（16〜50文字）」で日本語で返してください。
必ず次のJSONだけを返してください：
{"satire":"…","type":"…"}
- "satire": 一行の風刺文（句点は任意）
- "type": 社会風刺/仕事風刺/恋愛風刺/テクノロジー風刺 など
言葉: ${word}`
    };

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
    
        messages: [
          { role: "system", content: "You are a concise Japanese copywriter for satire." },
          prompt
        ],
        
        // ★ JSONモード（壊れた文字列を防ぐ）
        response_format: { type: "json_object" }
      })
    });

    if (!r.ok) {
      const text = await r.text();
      // 失敗時も何か返す
      return json({ ...localFallback(word), error: `OpenAI ${r.status}: ${text}` });
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

  // フロントで入力語を先頭につける設計に合わせ、ここは本文のみ返す
  return { satire, type };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}