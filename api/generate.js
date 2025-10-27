// Vercel Serverless Function (Node.js ESM)
export const config = { runtime: "edge" };
// ↑ レイテンシ重視なら edge。Node.js runtime を使うなら { runtime: "nodejs" }

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL   = process.env.OPENAI_MODEL || "gpt-5-mini";

async function callOpenAI(word) {
  const prompt = `次の言葉に対する風刺または皮肉を「一言（1行）」で日本語で出力してください。
出力は以下のJSONで返してください：
{"satire":"…","type":"…"}
- "satire": 18〜50文字目安の短文
- "type": 文脈に合うカテゴリ名（例：社会風刺/仕事風刺/恋愛風刺/テクノロジー風刺 など）
言葉: ${word}`;

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
        { role: "user", content: prompt }
      ],
      temperature: 0.8
    })
  });

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`OpenAI error: ${r.status} ${text}`);
  }
  const data = await r.json();
  const content = data?.choices?.[0]?.message?.content?.trim();
  try {
    const parsed = JSON.parse(content);
    return {
      satire: String(parsed.satire || "").trim(),
      type: String(parsed.type || "社会風刺").trim()
    };
  } catch {
    // モデルがJSON以外を返したときの保険
    return {
      satire: content?.replace(/^["{]+|["}]+$/g, "") || `${word}：期待と現実の隙間に咲くため息。`,
      type: "社会風刺"
    };
  }
}

export default async function handler(req) {
  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Only POST" }), { status: 405 });
    }
    const body = await req.json();
    const word = String(body?.word || "").trim();
    if (!word) {
      return new Response(JSON.stringify({ error: "word is required" }), { status: 400 });
    }

    if (!OPENAI_API_KEY) {
      // APIキー未設定でもアプリが動くようにフォールバック
      const fallback = localFallback(word);
      return new Response(JSON.stringify(fallback), { status: 200 });
    }

    const out = await callOpenAI(word);
    return new Response(JSON.stringify(out), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (e) {
    // サーバ側でもフォールバック
    const word = (() => {
      try { return String((await req.json())?.word || ""); }
      catch { return ""; }
    })();
    const fallback = localFallback(word);
    return new Response(JSON.stringify({ ...fallback, error: String(e?.message || e) }), { status: 200 });
  }
}

function localFallback(w) {
  const word = String(w || "").trim();
  let satire;
  if (!word) satire = "空白：一番誤魔化しやすい答え。";
  else if (word.toLowerCase().includes("ai")) satire = "AI：人間がサボる理由を自動生成。";
  else if (word.includes("上司")) satire = "上司：責任を部下にクラウド化。";
  else if (word.includes("お金")) satire = "お金：幸福の代わりに数えやすさをくれる。";
  else satire = `${word}：期待と現実のスキマで増殖する言い訳。`;

  let type = "社会風刺";
  if (word.toLowerCase().includes("ai")) type = "テクノロジー風刺";
  else if (word.includes("上司")) type = "仕事風刺";
  else if (word.includes("恋") || word.includes("愛")) type = "恋愛風刺";

  return { satire, type };
}