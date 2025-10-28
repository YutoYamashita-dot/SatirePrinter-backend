// backend-vercel/api/generate.js
// 他の箇所は絶対に変えず、以下の点だけ修正：
// 1) フロントの「短め/長め」ボタンと連携（body.length に "short"/"long" が来たら従う。来ない場合は word に含めた注記も検出）
// 2) 使うAPIを Grok-4（x.ai）に変更（XAI_API_KEY / XAI_MODEL）
// 3) OpenAI専用パラメータを削除し、JSON返却はプロンプトで厳格指示
// 4) “呟くように鋭い皮肉/風刺” になるようプロンプト強化（デフォはやや長め）
// 5) 追加要件：プリンター＝断定調、スマイル＝呟き調
// 6) さらに修正：プリンターにも「長め」があり得るため、スタイルは“画面（printer/smile）”で決定し、長さは length で独立に決定

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

    // ★ スタイル（画面）決定：printer/smile
    // 1) 明示指定: body.style / body.screen / body.mode
    // 2) 互換タグ: word に「(プリンター) / (スマイル) / [printer] / [smile]」等があればそれで解釈
    // 3) どれも無ければ従来互換: short→printer, long→smile
    let styleMode = String(body?.style ?? body?.screen ?? body?.mode ?? "").toLowerCase(); // "printer" | "smile" | ""
    if (!styleMode) {
      if (/[[(（]?\s*プリンター\s*[]）)]?/i.test(rawWord) || /\bprinter\b/i.test(rawWord)) styleMode = "printer";
      else if (/[[(（]?\s*スマイル\s*[]）)]?/i.test(rawWord) || /\bsmile\b/i.test(rawWord)) styleMode = "smile";
    }
    if (!styleMode) {
      styleMode = (lengthMode === "short") ? "printer" : "smile"; // 互換デフォルト
    }

    // 実際にモデルへ渡す「言葉」から、表示用注記は取り除く（長さ・画面タグの痕跡も除去）
    const word = rawWord
      .replace(/\s*\((短め|長め)[^)]+\)\s*$/,'')
      .replace(/[[(（]\s*(プリンター|スマイル|printer|smile)\s*[]）)]/ig, '')
      .trim();

    if (!XAI_API_KEY) {
      // キー未設定でも落ちない保険
      return json(localFallback(word, lengthMode, styleMode));
    }

    // ★ 長さ制約（日本語の“文字数”目安）
    const lengthRule = lengthMode === "short"
      ? "短め（14〜30文字）"
      : "長め（30〜70文字）";

    // === スタイル定義（長さと独立） ===
    // ★ 要求に合わせて「プリンターもスマイルも断定調」に統一
    // - 両スタイル共通：一人称や曖昧表現を避け、断定形で言い切る。三点リーダ「…」禁止。末尾は「。」で締める。
    //   禁止：『…』『？』『！』『かも』『かな』『気がする』『でしょう』『と思う』などの曖昧表現／疑問形。
    //   望ましい終止形例：〜である。〜だ。〜に過ぎない。〜ではない。〜に尽きる。
    const styleLine =
      "スタイル＝断定調。三点リーダ「…」や疑問符・感嘆符は使わず、必ず断定で「。」で締める（例：〜である。〜だ。〜ではない。〜に過ぎない。）。「かも」「かな」「気がする」「でしょう」「と思う」等は禁止。";

    // プロンプト（JSONのみ返答するよう厳格指示）
    const systemMsg =
      "You are a Japanese satirist who writes one-line satire and returns JSON only. " +
      "Avoid hate speech, slurs, doxxing, or explicit personal attacks on private individuals. " +
      "Never mention specific living persons or companies unless the user explicitly provided the term. " +
      "Return JSON only.";

    const userMsg =
`次の「言葉」について、${lengthRule}の**鋭く辛辣な風刺/皮肉**を日本語で作成してください。
${styleLine}
追加要件:
- 固有名は一般語に言い換え（必要なときのみ）
- 出力は**次のJSONのみ**（前後に何も書かない）
{"satire":"…","type":"…"}
- "satire": 一行（スタイルルールに従う）
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
      return json({ ...localFallback(word, lengthMode, styleMode), error: `Grok ${r.status}: ${text}` });
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
      return json(localFallback(word, lengthMode, styleMode));
    }

    return json({ satire, type });
  } catch (e) {
    return json({ ...localFallback("", "long", "smile"), error: String(e?.message || e) }, 200);
  }
}

// ローカルフォールバック：断定調に統一（スマイルも断定文）
function localFallback(w, lengthMode = "long", styleMode = "auto") {
  const word = String(w || "").trim() || "それ";

  // 断定調サンプル（句点で締め、曖昧表現と三点リーダを使わない）
  const poolLong = [
    `${word}は期待だけを膨らませて中身を痩せさせる。`,
    `${word}は安心の代用品に過ぎず、責任の所在をぼかす。`,
    `${word}を唱えるほど決断は遅れ、費用だけが積み上がる。`,
    `${word}は希望の衣を着た締切であり、猶予を装う義務だ。`
  ];
  const poolShort = [
    `${word}は現実逃避の飾りだ。`,
    `${word}は免罪符に過ぎない。`,
    `${word}が足りないのではなく決断が足りない。`,
    `${word}は責任の所在を溶かす。`
  ];

  const long = lengthMode === "long";
  const arr = long ? poolLong : poolShort;
  const satire = arr[Math.floor(Math.random() * arr.length)];

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