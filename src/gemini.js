const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

export async function listGeminiModels(apiKey) {
  const res = await fetch(`${ENDPOINT}?pageSize=100`, { headers: { "x-goog-api-key": apiKey } });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
  const models = data?.models || [];
  return models
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => ({ id: (m.name || "").replace(/^models\//, ""), label: m.displayName || m.name }))
    .filter((m) => m.id);
}

export async function geminiTranslatePage({ apiKey, model, imageDataUrl, count, srcLang = "auto", targetLang = "Vietnamese", context = "" }) {
  const base64 = imageDataUrl.split(",")[1];
  const mime = /data:(.*?);/.exec(imageDataUrl)?.[1] || "image/jpeg";
  const prompt = [
    "You are a professional manga/comic translator.",
    `The image is a comic page. Red numbered boxes mark the text regions (numbers 1..${count}).`,
    `For EACH number, read the ORIGINAL text inside that box, then translate it into natural, colloquial ${targetLang}.`,
    srcLang && srcLang !== "auto" ? `The source language is ${srcLang}.` : "",
    context ? `Context/series: ${context}` : "",
    "Return ONLY minified JSON, no markdown, of the form:",
    '{"1":{"src":"original text","vi":"translated text"}, ...}',
    "Omit any box you cannot read. Do not add comments. Keep the original punctuation style.",
  ]
    .filter(Boolean)
    .join("\n");

  const body = {
    contents: [
      {
        parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: base64 } }],
      },
    ],
    generationConfig: { temperature: 0.2, response_mime_type: "application/json" },
  };

  const res = await fetch(`${ENDPOINT}/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error?.message || `HTTP ${res.status}`);
    err.status = res.status;
    const details = data?.error?.details || [];
    const retry = details.find((d) => String(d["@type"] || "").includes("RetryInfo"));
    if (retry?.retryDelay) err.retryDelay = retry.retryDelay;
    if (!err.retryDelay) {
      const m = /retry in ([\d.]+h)?([\d.]+m)?([\d.]+s)?/i.exec(err.message);
      if (m) err.retryDelay = `${m[1] || ""}${m[2] || ""}${m[3] || ""}`;
    }
    throw err;
  }
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  const cleaned = text.replace(/^```json\s*|```\s*$/g, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : {};
  }
  return { map: parsed, usage: data?.usageMetadata || null };
}
