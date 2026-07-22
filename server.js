require("dotenv").config();
const express = require("express");
const multer = require("multer");
const path = require("path");
const OpenAI = require("openai");

let openai;
if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
} else {
  console.warn("[WARN] OPENAI_API_KEY chyba v .env.");
}

const app = express();
const PORT = process.env.PORT || 4000;

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

function buildPrompt(lang) {
  const languageName = { sk: "Slovak", en: "English", de: "German" }[(["sk", "en", "de"].includes(lang) ? lang : "sk")];
  
  return `Analyze this food package or label image and return STRICT JSON only.
The printed text may be in Swedish, German, Polish, Slovak, English, or any European language.
Perform precise OCR and translate all output texts into ${languageName}.

Return a JSON object with this EXACT structure (do not change key names):
{
  "scan": {
    "status": "success",
    "language": "${lang}",
    "highlights": [
      { "x": 10, "y": 20, "w": 30, "h": 15, "label": "E211 / Cukor", "severity": "danger" }
    ]
  },
  "product": {
    "name": "Názov produktu preložený do ${languageName}",
    "category": "Kategória (napr. Pečivo, Mliečne výrobky, Šalát)",
    "portion": "Veľkosť porcie alebo balenia (napr. 200g)"
  },
  "analysis": {
    "verdict": {
      "score": 65,
      "severity": "orange",
      "label": "Vhodné s mierou / Radšej obmedziť / Výborná voľba"
    },
    "recommendation": "Detailné 2-3 vetové zhodnotenie produktu v reči ${languageName}. Vysvetli zloženie a E-čka.",
    "scores": {
      "sugar": { "value": "12g / 100g", "level": "Stredný", "severity": "orange" },
      "salt": { "value": "0.8g / 100g", "level": "Nízky", "severity": "green" },
      "additives": { "value": "2 prídavné látky (E211, E202)", "level": "Pozor", "severity": "orange" },
      "processing": { "value": "Spracovaná potravina", "level": "Mierne vyššie", "severity": "orange" }
    },
    "healthierSwap": {
      "enabled": true,
      "summary": "Stručný tip na zdravšiu alternatívu z obchodu",
      "improvement": "+20 bodov",
      "product": {
        "name": "Názov zdravšej alternatívy",
        "score": 85,
        "sugar": "2g / 100g",
        "salt": "0.4g / 100g",
        "additives": "Bez E-čiek",
        "processing": "Minimálne spracované"
      }
    }
  },
  "ui": {
    "mode": "live",
    "progressTitle": "Analýza dokončená",
    "progressText": "Všetky dáta boli úspešne prečítané z obalu.",
    "ocrStatus": "Hotovo"
  }
}

Severity can only be: "green", "orange", or "red".
Write all string values strictly in ${languageName}. No markdown wrappers. Return STRICT JSON.`;
}

function extractText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(p => p?.text || "").join("\n");
  return "";
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, hasApiKey: Boolean(process.env.OPENAI_API_KEY) });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.post("/api/scan", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Chyba príloha 'image' vo FormData." });
    }

    if (!openai) {
      return res.status(500).json({ error: "OPENAI_API_KEY chyba na serveri." });
    }

    const lang = ["sk", "en", "de"].includes(req.body?.lang) ? req.body.lang : "sk";
    const mimeType = req.file.mimetype || "image/jpeg";
    const base64Image = req.file.buffer.toString("base64");

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are an expert food label analysis engine. Extract text from the image, translate all findings to ${lang === "sk" ? "Slovak" : lang === "en" ? "English" : "German"}, and return ONLY valid JSON matching the exact requested schema.`
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

    const content = extractText(completion?.choices?.[0]?.message?.content);
    if (!content) {
      return res.status(502).json({ error: "OpenAI nevráil žiadny obsah." });
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      return res.status(502).json({ error: `Neplatná JSON odpoveď od OpenAI: ${err.message}` });
    }

    if (parsed?.error) {
      return res.status(422).json({ error: parsed.error });
    }

    return res.json(parsed);
  } catch (err) {
    console.error("[/api/scan] OpenAI API chyba:", err);
    return res.status(502).json({ error: String(err?.message || err) });
  }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `Chyba uploadu: ${err.message}` });
  }
  if (err) {
    return res.status(400).json({ error: err.message || "Neznáma chyba." });
  }
  next();
});

app.listen(PORT, () => {
  console.log(`Food Scanner backend beží na portu ${PORT}`);
});
