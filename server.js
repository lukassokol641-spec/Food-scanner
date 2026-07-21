require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const OpenAI = require("openai");

const app = express();
const PORT = process.env.PORT || 4000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

if (!OPENAI_API_KEY) {
  console.warn("[WARN] OPENAI_API_KEY chyba v .env.");
}

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

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

function normalizeLang(lang) {
  return ["sk", "en", "de"].includes(lang) ? lang : "sk";
}

function extractTextFromMessage(msg) {
  if (!msg) return "";
  if (typeof msg === "string") return msg;
  if (Array.isArray(msg)) return msg.map(x => x?.text || "").join("\n");
  return "";
}

function buildPrompt(lang) {
  const map = { sk: "Slovak", en: "English", de: "German" };
  const languageName = map[normalizeLang(lang)];
  return `Analyze this food package / label image and return STRICT JSON only. Read the exact printed text first before classifying the product. The product label may be in Swedish, German, Polish or other European languages. Read the exact printed text first before classifying the product. If the text is not readable, return exactly this JSON error object: {"error":"Text na etikete nie je čitateľný, skúste odfotiť zblízka"}.
Return this schema:
{
  "scan":{"detectedText":["..."],"highlights":[{"label":"string","severity":"danger|warn","x":10,"y":20,"w":30,"h":12}]},
  "product":{"name":"string","category":"string","portion":"string","brand":"string"},
  "analysis":{"verdict":{"label":"string","severity":"green|orange|red","score":0,"summary":"string"},"scores":{"sugar":{"value":"string","level":"string","severity":"green|orange|red"},"salt":{"value":"string","level":"string","severity":"green|orange|red"},"additives":{"value":"string","level":"string","severity":"green|orange|red"},"processing":{"value":"string","level":"string","severity":"green|orange|red"}},"recommendation":"string","healthierSwap":{"enabled":true,"title":"string","summary":"string","improvement":"+NN% string","product":{"name":"string","score":0,"sugar":"string","salt":"string","additives":"string","processing":"string"}}},
  "ui":{"ocrStatus":"string","progressTitle":"string","progressText":"string"}
}
Write all user-facing strings in ${languageName}. No markdown, no explanation. Keep JSON keys exactly as written.`;
}

function sanitizeScoreBlock(block, fallback) {
  const b = block || {};
  const sev = ["green", "orange", "red"].includes(b.severity) ? b.severity : fallback.severity;
  return { value: b.value || fallback.value, level: b.level || fallback.level, severity: sev };
}

function sanitizeResponse(raw) {
  if (raw?.error) return { error: raw.error };
  const fb = {
    scan: { detectedText: [], highlights: [] },
    product: { name: "", category: "", portion: "", brand: "" },
    analysis: {
      verdict: { label: "", severity: "orange", score: 0, summary: "" },
      scores: {
        sugar: { value: "", level: "", severity: "orange" },
        salt: { value: "", level: "", severity: "orange" },
        additives: { value: "", level: "", severity: "orange" },
        processing: { value: "", level: "", severity: "orange" }
      },
      recommendation: "",
      healthierSwap: { enabled: false, title: "", summary: "", improvement: "", product: { name: "", score: 0, sugar: "", salt: "", additives: "", processing: "" } }
    },
    ui: { ocrStatus: "OCR", progressTitle: "OK", progressText: "OK" }
  };
  const score = raw?.analysis?.scores || {};
  return {
    scan: {
      source: "live",
      imagePreview: null,
      detectedText: Array.isArray(raw?.scan?.detectedText) ? raw.scan.detectedText : fb.scan.detectedText,
      highlights: Array.isArray(raw?.scan?.highlights) ? raw.scan.highlights.slice(0, 8) : fb.scan.highlights
    },
    product: {
      name: raw?.product?.name || fb.product.name,
      category: raw?.product?.category || fb.product.category,
      portion: raw?.product?.portion || fb.product.portion,
      brand: raw?.product?.brand || fb.product.brand
    },
    analysis: {
      verdict: {
        label: raw?.analysis?.verdict?.label || fb.analysis.verdict.label,
        severity: ["green", "orange", "red"].includes(raw?.analysis?.verdict?.severity) ? raw.analysis.verdict.severity : fb.analysis.verdict.severity,
        score: Math.max(0, Math.min(100, Number(raw?.analysis?.verdict?.score ?? 0))),
        summary: raw?.analysis?.verdict?.summary || fb.analysis.verdict.summary
      },
      scores: {
        sugar: sanitizeScoreBlock(score.sugar, fb.analysis.scores.sugar),
        salt: sanitizeScoreBlock(score.salt, fb.analysis.scores.salt),
        additives: sanitizeScoreBlock(score.additives, fb.analysis.scores.additives),
        processing: sanitizeScoreBlock(score.processing, fb.analysis.scores.processing)
      },
      recommendation: raw?.analysis?.recommendation || fb.analysis.recommendation,
      healthierSwap: {
        enabled: !!raw?.analysis?.healthierSwap?.enabled,
        title: raw?.analysis?.healthierSwap?.title || fb.analysis.healthierSwap.title,
        summary: raw?.analysis?.healthierSwap?.summary || fb.analysis.healthierSwap.summary,
        improvement: raw?.analysis?.healthierSwap?.improvement || fb.analysis.healthierSwap.improvement,
        product: {
          name: raw?.analysis?.healthierSwap?.product?.name || fb.analysis.healthierSwap.product.name,
          score: Math.max(0, Math.min(100, Number(raw?.analysis?.healthierSwap?.product?.score ?? 0))),
          sugar: raw?.analysis?.healthierSwap?.product?.sugar || fb.analysis.healthierSwap.product.sugar,
          salt: raw?.analysis?.healthierSwap?.product?.salt || fb.analysis.healthierSwap.product.salt,
          additives: raw?.analysis?.healthierSwap?.product?.additives || fb.analysis.healthierSwap.product.additives,
          processing: raw?.analysis?.healthierSwap?.product?.processing || fb.analysis.healthierSwap.product.processing
        }
      }
    },
    ui: {
      mode: "live",
      ocrStatus: raw?.ui?.ocrStatus || "OCR",
      progressTitle: raw?.ui?.progressTitle || "Done",
      progressText: raw?.ui?.progressText || "Done"
    }
  };
}

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "../frontend/index.html")));
app.get("/api/health", (req, res) => res.json({ ok: true, hasApiKey: Boolean(OPENAI_API_KEY) }));

app.post("/api/scan", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Chyba priloha 'image' vo FormData." });
    if (!openai) return res.status(500).json({ error: "OPENAI_API_KEY chyba na serveri." });

    const lang = normalizeLang(req.body?.lang);
    const base64Image = req.file.buffer.toString("base64");
    const mimeType = req.file.mimetype || "image/jpeg";

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are a food label analysis engine. Perform precise OCR first, then classify only from the exact printed text. Return ONLY valid JSON. Write all user-facing text strictly in ${lang === "sk" ? "Slovak" : lang === "en" ? "English" : "German"}. If the image text is unreadable, return exactly: {"error":"Text na etikete nie je čitateľný, skúste odfotiť zblízka"}.`
        },
        {
          role: "user",
          content: [
            { type: "text", text: buildPrompt(lang) },
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64Image}` } }
          ]
        }
      ]
    });

    const content = extractTextFromMessage(completion?.choices?.[0]?.message?.content);
    if (!content) return res.status(502).json({ error: "OpenAI nevratil ziadny content." });

    const parsed = JSON.parse(content);
    if (parsed?.error) return res.status(422).json({ error: parsed.error });

    return res.json(sanitizeResponse(parsed));
  } catch (err) {
    console.error("[/api/scan] OpenAI/API chyba:", err);
    return res.status(502).json({ error: String(err?.message || err) });
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
