// backend-vercel/api/generate.js
// 他の箇所は絶対に変えず、以下の点だけ修正：
// ① アプリ指定の言語で必ず出力されるように、リクエストの言語タグを解釈してプロンプトに厳命
// ② フォールバック(localFallback) も同じ言語で返すように拡張

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

    // === 追加: アプリ指定の言語（言語タグ）を解釈 ===
    // 受け取り先候補: body.lang / body.language / body.locale
    // 例: "ja", "en", "zh-Hans", "zh-Hant", "es", ...
    const rawLang = String(body?.lang ?? body?.language ?? body?.locale ?? "").trim();
    const langTag = normalizeLangTag(rawLang || "ja"); // デフォルト: 日本語
    const langLine = languageStrictLine(langTag);      // 「この言語で必ず出力」の厳命文
    const langName = languageName(langTag);            // 人間可読名（例: 日本語, English）

    // ★ 長さモード決定（button から body.length / "short"|"long"）
    //    互換のため、word に "(短め" / "(長め" が含まれていたらそれも解釈
    let lengthMode = String(body?.length ?? "").toLowerCase(); // "short" | "long" | ""
    if (!lengthMode) {
      if (/\(短め/.test(rawWord)) lengthMode = "short";
      else if (/\(長め/.test(rawWord)) lengthMode = "long";
    }
    // デフォルトは “少し長め”
    if (lengthMode !== "short" && lengthMode !== "long") {
      lengthMode = "long";
    }

    // ★ スタイル（画面）決定：printer/smile
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
      return json(localFallback(word, lengthMode, styleMode, langTag));
    }

    // ★ 長さ制約
    const lengthRule = lengthMode === "short"
      ? "短め（14〜30文字）"
      : "長め（30〜70文字）";

    // === スタイル定義（断定調に統一） ===
    const styleLine =
      "スタイル＝文語の文章";

    // === プロンプト（言語厳守をsystemにも明記） ===
    const systemMsg =
      "You must always write the answer in the application-specified language. " +
      `LANG=${langTag}. ` +
      "Return JSON only. Avoid hate speech, slurs, doxxing. " 

    const userMsg =
`${langLine}
次の「言葉」について、${lengthRule}の**鋭く辛辣な風刺/皮肉**を${langName}で作成してください。難しい言葉は使わず、書き言葉で出力すること。喋り口調は絶対に禁止。
${styleLine}
追加要件:
- 固有名は一般語に言い換え（必要なときのみ）
- 出力は**次のJSONのみ**（前後に何も書かない）
{"satire":"…","type":"…"}
- "satire": 1行か2行（スタイルルールに従う）
- "type": 社会風刺/仕事風刺/恋愛風刺/テクノロジー風刺 など1語
言葉: ${word}`;

    // ★ x.ai Grok-4 へ
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
      })
    });

    if (!r.ok) {
      const text = await r.text();
      return json({ ...localFallback(word, lengthMode, styleMode, langTag), error: `Grok ${r.status}: ${text}` });
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
    const type   = String(parsed?.type   ?? languageTypeDefault(langTag)).trim();

    if (!satire) {
      return json(localFallback(word, lengthMode, styleMode, langTag));
    }

    return json({ satire, type });
  } catch (e) {
    return json({ ...localFallback("", "long", "smile", "ja"), error: String(e?.message || e) }, 200);
  }
}

// ==============================
// 追加: 言語関連の補助関数
// ==============================

function normalizeLangTag(tag) {
  const t = tag.replace('_','-').trim();
  // 既知タグのみそのまま。未指定は ja
  const known = new Set([
    "ja","en","zh-Hans","zh-Hant","es","fr","pt","de","ko",
    "hi","id","tr","ru","ar","bn","sw","mr","te","ta","vi"
  ]);
  if (known.has(t)) return t;
  // 一般的な縮約
  if (/^zh(-cn|Hans)?$/i.test(t)) return "zh-Hans";
  if (/^zh(-tw|hk|Hant)?$/i.test(t)) return "zh-Hant";
  if (/^zh$/i.test(t)) return "zh-Hans";
  return "ja";
}

function languageName(langTag) {
  switch (langTag) {
    case "en": return "English";
    case "zh-Hans": return "简体中文";
    case "zh-Hant": return "繁體中文";
    case "es": return "Español";
    case "fr": return "Français";
    case "pt": return "Português";
    case "de": return "Deutsch";
    case "ko": return "한국어";
    case "hi": return "हिन्दी";
    case "id": return "Bahasa Indonesia";
    case "tr": return "Türkçe";
    case "ru": return "Русский";
    case "ar": return "العربية";
    case "bn": return "বাংলা";
    case "sw": return "Kiswahili";
    case "mr": return "मराठी";
    case "te": return "తెలుగు";
    case "ta": return "தமிழ்";
    case "vi": return "Tiếng Việt";
    default: return "日本語";
  }
}

// 「この言語で必ず出力せよ」の厳命（モデルに強く指示）
function languageStrictLine(langTag) {
  const name = languageName(langTag);
  return `【重要】出力言語はアプリ指定の「${name}」（LANG=${langTag}）のみ。必ず ${name} で書き、他言語を混ぜないこと。`;
}

function languageTypeDefault(langTag) {
  switch (langTag) {
    case "en": return "Social satire";
    case "zh-Hans": return "社会讽刺";
    case "zh-Hant": return "社會諷刺";
    case "es": return "Sátira social";
    case "fr": return "Satire sociale";
    case "pt": return "Sátira social";
    case "de": return "Gesellschaftssatire";
    case "ko": return "사회 풍자";
    case "hi": return "सामाजिक व्यंग्य";
    case "id": return "Satir sosial";
    case "tr": return "Toplumsal hiciv";
    case "ru": return "Социальная сатира";
    case "ar": return "سخرية اجتماعية";
    case "bn": return "সামাজিক ব্যঙ্গ";
    case "sw": return "Udhihaka wa kijamii";
    case "mr": return "सामाजिक उपहास";
    case "te": return "సామాజిక వ్యంగ్యం";
    case "ta": return "சமூக கிண்டல்";
    case "vi": return "Châm biếm xã hội";
    default: return "社会風刺";
  }
}

// ==============================
// 変更: フォールバックも言語別で返す
// ==============================
function localFallback(w, lengthMode = "long", styleMode = "auto", langTag = "ja") {
  const word = String(w || "").trim() || pickWord(langTag);
  const long = lengthMode === "long";

  // 言語別の簡潔な断定文テンプレ
  const T = templates(langTag, word);
  const arr = long ? T.long : T.short;
  const satire = arr[Math.floor(Math.random() * arr.length)];

  let type = languageTypeDefault(langTag);
  const lower = word.toLowerCase();
  if (lower.includes("ai")) type = typeByLang(langTag, "tech");
  else if (word.includes("上司") || /boss|chef|jefe|主管|经理|manager/i.test(word)) type = typeByLang(langTag, "work");
  else if (/恋|愛|love|amor|amour|사랑|любов/i.test(word)) type = typeByLang(langTag, "love");

  return { satire, type };
}

function pickWord(langTag) {
  switch (langTag) {
    case "en": return "it";
    case "zh-Hans": return "它";
    case "zh-Hant": return "它";
    case "es": return "eso";
    case "fr": return "cela";
    case "pt": return "isso";
    case "de": return "das";
    case "ko": return "그것";
    case "hi": return "यह";
    case "id": return "itu";
    case "tr": return "bu";
    case "ru": return "это";
    case "ar": return "ذلك";
    case "bn": return "ওটা";
    case "sw": return "hicho";
    case "mr": return "ते";
    case "te": return "అది";
    case "ta": return "அது";
    case "vi": return "điều đó";
    default: return "それ";
  }
}

function typeByLang(langTag, kind) {
  const map = {
    tech: {
      ja:"テクノロジー風刺", en:"Tech satire", zhHans:"科技讽刺", zhHant:"科技諷刺", es:"Sátira tecnológica",
      fr:"Satire technologique", pt:"Sátira tecnológica", de:"Technik-Satire", ko:"기술 풍자",
      hi:"टेक व्यंग्य", id:"Satir teknologi", tr:"Teknoloji hicvi", ru:"Технологическая сатира",
      ar:"سخرية تقنية", bn:"প্রযুক্তি ব্যঙ্গ", sw:"Udhihaka wa teknolojia", mr:"तंत्रज्ञानावर उपहास",
      te:"సాంకేతిక వ్యంగ్యం", ta:"தொழில்நுட்ப கிண்டல்", vi:"Châm biếm công nghệ"
    },
    work: {
      ja:"仕事風刺", en:"Work satire", zhHans:"职场讽刺", zhHant:"職場諷刺", es:"Sátira laboral",
      fr:"Satire du travail", pt:"Sátira de trabalho", de:"Arbeits-Satire", ko:"직장 풍자",
      hi:"काम पर व्यंग्य", id:"Satir pekerjaan", tr:"İş hicvi", ru:"Сатира о работе",
      ar:"سخرية العمل", bn:"কর্মক্ষেত্র ব্যঙ্গ", sw:"Udhihaka wa kazi", mr:"कामावर उपहास",
      te:"పని పై వ్యంగ్యం", ta:"வேலை கிண்டல்", vi:"Châm biếm công việc"
    },
    love: {
      ja:"恋愛風刺", en:"Love satire", zhHans:"爱情讽刺", zhHant:"愛情諷刺", es:"Sátira amorosa",
      fr:"Satire amoureuse", pt:"Sátira de amor", de:"Liebes-Satire", ko:"연애 풍자",
      hi:"प्रेम व्यंग्य", id:"Satir cinta", tr:"Aşk hicvi", ru:"Сатира о любви",
      ar:"سخرية الحب", bn:"ভালোবাসার ব্যঙ্গ", sw:"Udhihaka wa mapenzi", mr:"प्रेमावर उपहास",
      te:"ప్రేమ వ్యంగ్యం", ta:"காதல் கிண்டல்", vi:"Châm biếm tình yêu"
    }
  };
  const key = kind === "tech" ? "tech" : kind === "work" ? "work" : "love";
  const langKey = langTag === "zh-Hans" ? "zhHans" : langTag === "zh-Hant" ? "zhHant" : langTag;
  return (map[key][langKey] ?? languageTypeDefault(langTag));
}

function templates(langTag, w) {
  switch (langTag) {
    case "en": return {
      long: [
        `${w} inflates promises while starving substance.`,
        `${w} is a substitute for certainty that blurs accountability.`,
        `${w} delays decisions while costs accumulate.`,
        `${w} is a deadline wearing hope.`
      ],
      short: [
        `${w} is an excuse.`,
        `${w} exposes the gap.`,
        `${w} is only a badge.`,
        `${w} dissolves responsibility.`
      ]
    };
    case "zh-Hans": return {
      long: [
        `${w}只会吹大承诺、瘦身内容。`,
        `${w}是廉价的安慰剂，顺便模糊责任。`,
        `${w}让决定变慢，代价却在累计。`,
        `${w}是披着希望外衣的最后期限。`
      ],
      short: [
        `${w}只是借口。`,
        `${w}暴露落差。`,
        `${w}不过是一枚徽章。`,
        `${w}把责任稀释。`
      ]
    };
    case "zh-Hant": return {
      long: [
        `${w}只會誇大承諾、掏空內容。`,
        `${w}是廉價安慰劑，也順手模糊責任。`,
        `${w}拖慢決策，成本卻持續累加。`,
        `${w}是披著希望外衣的最後期限。`
      ],
      short: [
        `${w}只是藉口。`,
        `${w}揭露落差。`,
        `${w}不過是一枚徽章。`,
        `${w}把責任稀釋。`
      ]
    };
    case "es": return {
      long: [
        `${w} hincha promesas y adelgaza el contenido.`,
        `${w} es un tranquilizante barato que difumina la responsabilidad.`,
        `${w} retrasa decisiones mientras el coste crece.`,
        `${w} es una fecha límite disfrazada de esperanza.`
      ],
      short: [
        `${w} es una excusa.`,
        `${w} revela la brecha.`,
        `${w} solo es una etiqueta.`,
        `${w} diluye la responsabilidad.`
      ]
    };
    case "fr": return {
      long: [
        `${w} gonfle les promesses et amaigrit le fond.`,
        `${w} n’est qu’un calmant qui floute la responsabilité.`,
        `${w} retarde la décision tandis que le coût grimpe.`,
        `${w} est une échéance déguisée en espoir.`
      ],
      short: [
        `${w} est une excuse.`,
        `${w} révèle l’écart.`,
        `${w} n’est qu’un badge.`,
        `${w} dilue la responsabilité.`
      ]
    };
    case "pt": return {
      long: [
        `${w} infla promessas e emagrece o conteúdo.`,
        `${w} é um placebo que desfoca a responsabilidade.`,
        `${w} atrasa decisões enquanto o custo cresce.`,
        `${w} é um prazo fantasiado de esperança.`
      ],
      short: [
        `${w} é desculpa.`,
        `${w} expõe o hiato.`,
        `${w} é só um selo.`,
        `${w} dilui a responsabilidade.`
      ]
    };
    case "de": return {
      long: [
        `${w} bläht Versprechen auf und hungert den Inhalt aus.`,
        `${w} ist ein Placebo, das Verantwortung verwischt.`,
        `${w} verzögert Entscheidungen, während Kosten steigen.`,
        `${w} ist eine Frist im Kostüm der Hoffnung.`
      ],
      short: [
        `${w} ist eine Ausrede.`,
        `${w} legt die Lücke offen.`,
        `${w} ist nur ein Abzeichen.`,
        `${w} löst Verantwortung auf.`
      ]
    };
    case "ko": return {
      long: [
        `${w}는 약속을 부풀리고 내용을 말린다.`,
        `${w}는 책임을 흐리는 값싼 위안제다.`,
        `${w}는 결정을 늦추고 비용만 쌓는다.`,
        `${w}는 희망을 걸친 마감일이다.`
      ],
      short: [
        `${w}는 변명이다.`,
        `${w}는 간극을 드러낸다.`,
        `${w}는 표시일 뿐이다.`,
        `${w}는 책임을 희석한다.`
      ]
    };
    case "hi": return {
      long: [
        `${w} वादों को फुलाता है और सार को पतला करता है।`,
        `${w} सस्ती तसल्ली है जो जिम्मेदारी धुंधली करती है।`,
        `${w} निर्णय टालता है, लागत बढ़ाता है।`,
        `${w} आशा के वस्त्रों में अंतिम तिथि है।`
      ],
      short: [
        `${w} बहाना है।`,
        `${w} अंतर उजागर करता है।`,
        `${w} केवल ठप्पा है।`,
        `${w} जिम्मेदारी घोल देता है।`
      ]
    };
    case "id": return {
      long: [
        `${w} mengembungkan janji dan menguruskan isi.`,
        `${w} penenang murah yang mengaburkan tanggung jawab.`,
        `${w} menunda keputusan sementara biaya naik.`,
        `${w} adalah tenggat yang menyamar jadi harapan.`
      ],
      short: [
        `${w} hanyalah alasan.`,
        `${w} membuka jurang.`,
        `${w} cuma lencana.`,
        `${w} melarutkan tanggung jawab.`
      ]
    };
    case "tr": return {
      long: [
        `${w} vaatleri şişirir, içeriği zayıflatır.`,
        `${w} sorumluluğu bulanıklaştıran ucuz bir tesellidir.`,
        `${w} kararları geciktirir, maliyetleri büyütür.`,
        `${w} umut kılığındaki son tarihtir.`
      ],
      short: [
        `${w} bir mazerettir.`,
        `${w} uçurumu açığa çıkarır.`,
        `${w} sadece bir rozet.`,
        `${w} sorumluluğu seyreltir.`
      ]
    };
    case "ru": return {
      long: [
        `${w} раздувает обещания и истончает содержание.`,
        `${w} — дешёвое утешение, размывающее ответственность.`,
        `${w} тормозит решения, а затраты растут.`,
        `${w} — дедлайн в костюме надежды.`
      ],
      short: [
        `${w} — это отговорка.`,
        `${w} выявляет разрыв.`,
        `${w} — лишь значок.`,
        `${w} размывает ответственность.`
      ]
    };
    case "ar": return {
      long: [
        `${w} ينفخ الوعود ويُنهك المضمون.`,
        `${w} مسكّن رخيص يطمس المسؤولية.`,
        `${w} يؤخر القرار بينما تتراكم الكلفة.`,
        `${w} موعد نهائي متنكر في هيئة أمل.`
      ],
      short: [
        `${w} ذريعة.`,
        `${w} يكشف الفجوة.`,
        `${w} مجرد شارة.`,
        `${w} يذيب المسؤولية.`
      ]
    };
    case "bn": return {
      long: [
        `${w} প্রতিশ্রুতি ফুলিয়ে বিষয়বস্তু শুকিয়ে দেয়।`,
        `${w} দায় ঝাপসা করা সস্তা সান্ত্বনা।`,
        `${w} সিদ্ধান্ত বিলম্বিত করে, খরচ বাড়ায়।`,
        `${w} আশা-পরা এক শেষ সময়সীমা।`
      ],
      short: [
        `${w} অজুহাত।`,
        `${w} ফাঁক উন্মোচন করে।`,
        `${w} কেবল এক ব্যাজ।`,
        `${w} দায় হালকা করে।`
      ]
    };
    case "sw": return {
      long: [
        `${w} huvimbisha ahadi na kuonda kiini.`,
        `${w} ni tulizo rahisi linaloficha uwajibikaji.`,
        `${w} huchelewesha uamuzi huku gharama zikiongezeka.`,
        `${w} ni tarehe ya mwisho iliyojifanya tumaini.`
      ],
      short: [
        `${w} ni kisingizio.`,
        `${w} hufichua pengo.`,
        `${w} ni beji tu.`,
        `${w} huyeyusha uwajibikaji.`
      ]
    };
    case "mr": return {
      long: [
        `${w} वचनं फुगवते आणि सार कमी करते.`,
        `${w} जबाबदारी धूसर करणारा स्वस्त दिलासा आहे.`,
        `${w} निर्णय उशिरा येतो, खर्च मात्र वाढतो.`,
        `${w} आशेच्या वेशातली अंतिम मुदत आहे.`
      ],
      short: [
        `${w} हे कारण आहे.`,
        `${w} दरी उघड करते.`,
        `${w} फक्त एक बॅज.`,
        `${w} जबाबदारी विरघळवते.`
      ]
    };
    case "te": return {
      long: [
        `${w} హామీలను ఉబ్బబెట్టి సారాన్ని కరిగిస్తుంది.`,
        `${w} బాధ్యతను మసకబార్చే చౌకైన ఓదార్పు.`,
        `${w} నిర్ణయాన్ని ఆలస్యం చేస్తుంది, ఖర్చు పెరుగుతుంది.`,
        `${w} ఆశ వేషం వేసుకున్న గడువు.`
      ],
      short: [
        `${w} ఒక సాకు.`,
        `${w} అంతరాన్ని బయటపడుస్తుంది.`,
        `${w} ఒక గుర్తు మాత్రమే.`,
        `${w} బాధ్యతను పలుచబరుస్తుంది.`
      ]
    };
    case "ta": return {
      long: [
        `${w} வாக்குறுதியை ஊதி உள்ளடக்கத்தை களைத்துவிடுகிறது.`,
        `${w} பொறுப்பை மங்காக்கும் மலிவு ஆறுதல்.`,
        `${w} தீர்மானத்தை தள்ளி, செலவைக் கூடுகிறது.`,
        `${w} நம்பிக்கையைத் தோளில் சுமந்த கடைசி நேரம்.`
      ],
      short: [
        `${w} ஒரு காரணம்.`,
        `${w} இடைவெளியை வெளிப்படுத்துகிறது.`,
        `${w} வெறும் குறியீடு.`,
        `${w} பொறுப்பை கரைக்கிறது.`
      ]
    };
    case "vi": return {
      long: [
        `${w} thổi phồng lời hứa và làm teo nội dung.`,
        `${w} là liều an thần rẻ làm mờ trách nhiệm.`,
        `${w} trì hoãn quyết định trong khi chi phí tăng.`,
        `${w} là hạn chót khoác áo hy vọng.`
      ],
      short: [
        `${w} là cái cớ.`,
        `${w} phơi bày khoảng cách.`,
        `${w} chỉ là phù hiệu.`,
        `${w} làm loãng trách nhiệm.`
      ]
    };
    default: // ja
      return {
        long: [
          `${w}は約束を膨らませて中身を痩せさせる。`,
          `${w}は責任をぼかす安上がりの慰めだ。`,
          `${w}は決断を遅らせ、費用だけを積み上げる。`,
          `${w}は希望をまとった締切である。`
        ],
        short: [
          `${w}は言い訳だ。`,
          `${w}は落差を露呈する。`,
          `${w}は記章に過ぎない。`,
          `${w}は責任を希釈する。`
        ]
      };
  }
}