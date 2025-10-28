// backend-vercel/api/generate.js
// 他の箇所は絶対に変えず、以下の点だけ修正：
// 1) フロントの「短め/長め」ボタンと連携（body.length に "short"/"long" が来たら従う。来ない場合は word に含めた注記も検出）
// 2) 使うAPIを Grok-4（x.ai）に変更（XAI_API_KEY / XAI_MODEL）
// 3) OpenAI専用パラメータを削除し、JSON返却はプロンプトで厳格指示
// 4) “呟くように鋭い皮肉/風刺” になるようプロンプト強化（デフォはやや長め）

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

    // ★ 長さモード決定（button から body.length / "short"|"long"）
    //    互換のため、word に "(短め" / "(長め" が含まれていたらそれも解釈
    let lengthMode = String(body?.length ?? "").toLowerCase(); // "short" | "long" | ""
    if (!lengthMode) {
      if (/\(短め/.test(rawWord)) lengthMode = "short";
      else if (/\(長め/.test(rawWord)) lengthMode = "long";
    }
    // デフォルトは “少し長め” の独白調に
    if (lengthMode !== "short" && lengthMode !== "long") {
      lengthMode = "long";
    }

    // 実際にモデルへ渡す「言葉」から、表示用注記は取り除く
    const word = rawWord.replace(/\s*\((短め|長め)[^)]+\)\s*$/,'').trim();

    if (!XAI_API_KEY) {
      // キー未設定でも落ちない保険
      return json(localFallback(word, lengthMode));
    }

    // ★ 長さ制約（日本語の“文字数”目安）
    //   呟きの間（…）を含めた自然な一息の長さになるよう幅を持たせる
    const lengthRule = lengthMode === "short"
      ? "短め（25〜60文字）"
      : "長め（80〜140文字）";

    // プロンプト（JSONのみ返答するよう厳格指示）
    const systemMsg =
      "You are a Japanese satirist who writes one-line, whispery barbed satire. " +
      "Style: murmured, compressed, sharp edge, dry wit, a little melancholy; use reversal and subtext. " +
      "Prefer first-person asides and ellipses like '…'. No emoji, no hashtags, no exclamation. " +
      "Avoid hate speech, slurs, doxxing, or explicit personal attacks on private individuals. " +
      "Never mention specific living persons or companies unless the user explicitly provided the term. " +
      "Return JSON only.";

    const userMsg =
`次の「言葉」について、${lengthRule}の**呟くように鋭い風刺/皮肉**を日本語で作成してください。
要件:
- ささやく独白調（語尾に「…」「かな」「かも」を適度に）
- 一撃で含意が伝わる比喩・反転・矛盾の捻りを1つ以上
- 固有名は一般語に言い換え（必要なときのみ）
- 出力は**次のJSONのみ**（前後に何も書かない）
{"satire":"…","type":"…"}
- "satire": 一行、句読点や三点リーダは可
- "type": 社会風刺/仕事風刺/恋愛風刺/テクノロジー風刺 など1語
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
      return json({ ...localFallback(word, lengthMode), error: `Grok ${r.status}: ${text}` });
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
      return json(localFallback(word, lengthMode));
    }

    return json({ satire, type });
  } catch (e) {
    return json({ ...localFallback("", "long"), error: String(e?.message || e) }, 200);
  }
}

// ローカルフォールバック：囁き調で少し長め
function localFallback(w, lengthMode = "long") {
  const word = String(w || "").trim() || "それ";
  const long = lengthMode === "long";

  const pool = [
    `${word}って…便利な魔法みたいに貼られるけど、貼った指先だけが空っぽになるんだよね…まあ、誰も見てないから言えるけど。`,
    `みんな${word}を欲しがるけど…欲しいのは安心の代用品で、領収書はいらないって顔…そんな夜、少しだけ静かになる。`,
    `${word}さえあれば…って呟く時ほど、他の歯車が欠けてて…音をごまかすために声を大きくするんだよ…たぶん。`,
    `${word}は希望のふりをした締め切り…伸ばせば伸ばすほど、約束の形だけが増える…ね。`
  ];
  const shortPool = [
    `${word}は言い訳を合法化するスタンプ…だよね。`,
    `足りないのは${word}より決心…かな。`,
    `${word}で静かになるのは心じゃなく計算機…かも。`
  ];

  const satire = (long ? pool : shortPool)[Math.floor(Math.random() * (long ? pool.length : shortPool.length))];

  let type = "社会風刺";
  const lower = word.toLowerCase();
  if (lower.includes("ai")) type = "テクノロジー風刺";
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