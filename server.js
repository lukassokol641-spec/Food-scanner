require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 4000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

if (!OPENAI_API_KEY) {
  console.warn("[WARN] OPENAI_API_KEY chyba v .env - /api/scan bude vracat demo fallback.");
}

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: "2mb" }));
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, "../frontend")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) return cb(new Error("Iba obrazkove formaty su povolene."));
    cb(null, true);
  }
});

const DEMO_RESPONSE = {
  scan: {
    source: "demo",
    imagePreview: null,
    detectedText: ["cukor", "glukozovo-fruktozovy sirup", "palmovy olej", "E322", "E500"],
    highlights: [
      { label: "pridany cukor", severity: "danger", x: 14, y: 28, w: 42, h: 12 },
      { label: "sirup", severity: "danger", x: 19, y: 44, w: 54, h: 12 },
      { label: "ecka", severity: "warn", x: 60, y: 62, w: 18, h: 10 }
    ]
  },
  product: { name: "Cokoladovy keksik", category: "Sladke pecivo", portion: "50 g", brand: "Demo Snack" },
  analysis: {
    verdict: { label: "Radsej obmedzit", severity: "orange", score: 42, summary: "Vysoky podiel pridaneho cukru a ultra-spracovanych zloziek." },
    scores: {
      sugar: { value: "31.6 g / 100 g", level: "Vysoky", severity: "red" },
      salt: { value: "0.78 g / 100 g", level: "Stredna", severity: "orange" },
      additives: { value: "2 detegovane", level: "Stredne riziko", severity: "orange" },
      processing: { value: "Ultra-spracovane", level: "Vysoke", severity: "red" }
    },
    recommendation: "Pre kazdodenne snackovanie je lepsie zvolit jednoduchsi produkt s nizsim cukrom.",
    healthierSwap: {
      enabled: true,
      title: "Zdravsia alternativa",
      summary: "Ovocno-ovsena tycinka ma menej cukru a menej aditiv.",
      improvement: "+80% lepsie",
      product: { name: "Ovocno-ovsena tycinka", score: 76, sugar: "9.2 g / 100 g", salt: "0.12 g / 100 g", additives: "0 detegovanych", processing: "Nizko spracovane" }
    }
  },
  ui: { mode: "demo", ocrStatus: "Demo OCR zvyraznenie", progressTitle: "Demo analyza pripravena", progressText: "Ukazkove data z demo scenara." }
};

function toStr(v, fallback) { return typeof v === "string" && v.trim() ? v : fallback; }
function toNum(v, fallback) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
function toBool(v, fallback) { return typeof v === "boolean" ? v : fallback; }
function toSeverity(v) { return ["green", "orange", "red"].includes(v) ? v : "orange"; }
function toHighlightSeverity(v) { return v === "danger" ? "danger" : "warn"; }

function sanitizeScoreBlock(block, fallback) {
  const b = block || {};
  return { value: toStr(b.value, fallback.value), level: toStr(b.level, fallback.level), severity: toSeverity(b.severity) };
}

function sanitizeHighlights(list) {
  if (!Array.isArray(list)) return DEMO_RESPONSE.scan.highlights;
  const cleaned = list.filter(h => h && typeof h === "object").map(h => ({
    label: toStr(h.label, "neznama zlozka"),
    severity: toHighlightSeverity(h.severity),
    x: Math.min(100, Math.max(0, toNum(h.x, 10))),
    y: Math.min(100, Math.max(0, toNum(h.y, 10))),
    w: Math.min(100, Math.max(4, toNum(h.w, 20))),
    h: Math.min(100, Math.max(4, toNum(h.h, 10)))
  })).slice(0, 8);
  return cleaned.length ? cleaned : DEMO_RESPONSE.scan.highlights;
}

function sanitizeAiResponse(raw) {
  const fb = DEMO_RESPONSE;
  const data = raw && typeof raw === "object" ? raw : {};
  const scan = data.scan || {};
  const product = data.product || {};
  const analysis = data.analysis || {};
  const verdict = analysis.verdict || {};
  const scores = analysis.scores || {};
  const swap = analysis.healthierSwap || {};
  const swapProduct = swap.product || {};
  const ui = data.ui || {};
  return {
    scan: {
      source: "live",
      imagePreview: null,
      detectedText: Array.isArray(scan.detectedText) && scan.detectedText.length ? scan.detectedText.slice(0, 12).map(t => toStr(t, "")).filter(Boolean) : fb.scan.detectedText,
      highlights: sanitizeHighlights(scan.highlights)
    },
    product: {
      name: toStr(product.name, fb.product.name),
      category: toStr(product.category, fb.product.category),
      portion: toStr(product.portion, fb.product.portion),
      brand: toStr(product.brand, fb.product.brand)
    },
    analysis: {
      verdict: {
        label: toStr(verdict.label, fb.analysis.verdict.label),
        severity: toSeverity(verdict.severity),
        score: Math.min(100, Math.max(0, toNum(verdict.score, fb.analysis.verdict.score))),
        summary: toStr(verdict.summary, fb.analysis.verdict.summary)
      },
      scores: {
        sugar: sanitizeScoreBlock(scores.sugar, fb.analysis.scores.sugar),
        salt: sanitizeScoreBlock(scores.salt, fb.analysis.scores.salt),
        additives: sanitizeScoreBlock(scores.additives, fb.analysis.scores.additives),
        processing: sanitizeScoreBlock(scores.processing, fb.analysis.scores.processing)
      },
      recommendation: toStr(analysis.recommendation, fb.analysis.recommendation),
      healthierSwap: {
        enabled: toBool(swap.enabled, true),
        title: toStr(swap.title, "Zdravsia alternativa"),
        summary: toStr(swap.summary, fb.analysis.healthierSwap.summary),
        improvement: toStr(swap.improvement, fb.analysis.healthierSwap.improvement),
        product: {
          name: toStr(swapProduct.name, fb.analysis.healthierSwap.product.name),
          score: Math.min(100, Math.max(0, toNum(swapProduct.score, fb.analysis.healthierSwap.product.score))),
          sugar: toStr(swapProduct.sugar, fb.analysis.healthierSwap.product.sugar),
          salt: toStr(swapProduct.salt, fb.analysis.healthierSwap.product.salt),
          additives: toStr(swapProduct.additives, fb.analysis.healthierSwap.product.additives),
          processing: toStr(swapProduct.processing, fb.analysis.healthierSwap.product.processing)
        }
      }
    },
    ui: {
      mode: "live",
      ocrStatus: toStr(ui.ocrStatus, "AI OCR zvyraznenie"),
      progressTitle: toStr(ui.progressTitle, "Analyza hotova"),
      progressText: toStr(ui.progressText, "Data su nacitane z AI odpovede.")
    }
  };
}

const LANG_NAMES = { sk: "Slovak", en: "English", de: "German" };
function normalizeLang(lang) { return ["sk", "en", "de"].includes(lang) ? lang : "sk"; }

function buildJsonPrompt(lang) {
  const languageName = LANG_NAMES[normalizeLang(lang)];
  return `Analyze this food package / label image and return STRICTLY VALID JSON with EXACTLY these top-level keys: {"scan":{"detectedText":["..."],"highlights":[{"label":"string","severity":"danger|warn","x":10,"y":20,"w":30,"h":12}]},"product":{"name":"string","category":"string","portion":"string","brand":"string"},"analysis":{"verdict":{"label":"string","severity":"green|orange|red","score":0,"summary":"string"},"scores":{"sugar":{"value":"string","level":"string","severity":"green|orange|red"},"salt":{"value":"string","level":"string","severity":"green|orange|red"},"additives":{"value":"string","level":"string","severity":"green|orange|red"},"processing":{"value":"string","level":"string","severity":"green|orange|red"}},"recommendation":"string","healthierSwap":{"enabled":true,"title":"string","summary":"string","improvement":"+NN% string","product":{"name":"string","score":0,"sugar":"string","salt":"string","additives":"string","processing":"string"}}},"ui":{"ocrStatus":"string","progressTitle":"string","progressText":"string"}} Rules: Return ONLY JSON, no markdown fences, no explanation. Write ALL user-facing string values (labels, summaries, level names, recommendation, healthierSwap, ui) in ${languageName}. Keep JSON keys in English exactly as specified. Estimate conservatively when exact values are not visible. The product label may be in Swedish, German, Polish or other European languages. Read the exact printed text first before classifying the product. If the text is not readable, do not guess the product. Return exactly this JSON error object instead: {"error":"Text na etikete nie je čitateľný, skúste odfotiť zblízka"}. highlights coordinates are percentages relative to image for overlay placement. healthierSwap must be filled with a plausible healthier alternative from the same category, described in ${languageName}.`.trim();
}

function extractJson(text) { const start = text.indexOf("{"); const end = text.lastIndexOf("}"); if (start === -1 || end === -1) throw new Error("Nepodarilo sa najst JSON v odpovedi modelu."); return text.slice(start, end + 1); }

async function callOpenAiVision(base64Image, mimeType, lang) {
  const languageName = LANG_NAMES[normalizeLang(lang)];
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: "gpt-4o",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: `You are a food label analysis engine. Perform precise OCR first, then classify only from the exact printed text. Return ONLY valid JSON matching the requested schema. Write all user-facing text strictly in ${languageName}. No markdown, no explanation. If the image text is unreadable, return exactly: {"error":"Text na etikete nie je čitateľný, skúste odfotiť zblízka"}.` },
        { role: "user", content: [{ type: "text", text: buildJsonPrompt(lang) }, { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64Image}` } }] }
      ]
    })
  });
  if (!response.ok) throw new Error(`OpenAI API chyba (${response.status}): ${await response.text()}`);
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI nevratil ziadny content.");
  const parsed = JSON.parse(extractJson(content));
  if (parsed && parsed.error) throw new Error(parsed.error);
  return parsed;
}

const FALLBACK_MESSAGES = {
  sk: { missingKey: "API kluc chyba na serveri - zobrazene demo data.", aiFailed: "AI analyza zlyhala - zobrazene demo data." },
  en: { missingKey: "API key is missing on the server - showing demo data.", aiFailed: "AI analysis failed - showing demo data." },
  de: { missingKey: "API-Schluessel fehlt auf dem Server - Demo-Daten werden angezeigt.", aiFailed: "KI-Analyse fehlgeschlagen - Demo-Daten werden angezeigt." }
};

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "../frontend/index.html")));
app.get("/api/health", (req, res) => res.json({ ok: true, hasApiKey: Boolean(OPENAI_API_KEY) }));

app.post("/api/scan", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Chyba priloha 'image' vo FormData." });
    const lang = normalizeLang(req.body?.lang);
    const messages = FALLBACK_MESSAGES[lang];
    if (!OPENAI_API_KEY) {
      console.warn("[/api/scan] OPENAI_API_KEY chyba, vracam demo fallback.");
      return res.json({ ...DEMO_RESPONSE, ui: { ...DEMO_RESPONSE.ui, progressText: messages.missingKey } });
    }
    const base64Image = req.file.buffer.toString("base64");
    const mimeType = req.file.mimetype || "image/jpeg";
    let aiRaw;
    try {
      aiRaw = await callOpenAiVision(base64Image, mimeType, lang);
    } catch (aiError) {
      const msg = String(aiError?.message || "");
      if (msg.includes("Text na etikete nie je čitateľný")) {
        return res.status(422).json({ error: "Text na etikete nie je čitateľný, skúste odfotiť zblízka" });
      }
      console.error("[/api/scan] OpenAI zlyhalo, vracam demo fallback:", aiError.message);
      return res.json({ ...DEMO_RESPONSE, ui: { ...DEMO_RESPONSE.ui, progressText: messages.aiFailed } });
    }
    return res.json(sanitizeAiResponse(aiRaw));
  } catch (err) {
    console.error("[/api/scan] Neocakavana chyba:", err);
    return res.status(500).json({ error: "Interna chyba servera pri spracovani skenu." });
  }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: `Chyba uploadu: ${err.message}` });
  if (err) return res.status(400).json({ error: err.message || "Neznama chyba." });
  next();
});

app.listen(PORT, () => {
  console.log(`Food Scanner backend bezi na http://localhost:${PORT}`);
});
