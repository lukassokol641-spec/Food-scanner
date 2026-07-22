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
  
  return `
Analyze this food package / label image and return STRICT JSON only. 
The product label may be in Swedish, German, Polish, or other European languages.
Read the exact printed text first before classifying the product.

Perform a full breakdown and translate all text into ${languageName}.

If the text is not readable, return exactly this JSON error object: 
{"error": "Text na etikete nie je čitateľný, skúste odfotiť zblízka"}

Otherwise, return a JSON object with this EXACT structure:
{
  "scan": {
    "status": "success",
    "language": "${lang}"
  },
  "product": {
    "name": "Exact or translated product name",
    "brand": "Brand name if visible, or null",
    "category": "e.g. Bakery, Dairy, Snacks"
  },
  "analysis": {
    "ingredients": [
      "Translated ingredient 1",
      "Translated ingredient 2"
    ],
    "additives": [
      {
        "code": "E-number (e.g. E211) or name",
        "name": "Translated name of additive",
        "type": "Natural / Synthetic / Fermented",
        "risk": "Low / Medium / High",
        "info": "Brief clear explanation of what it does and health considerations"
      }
    ],
    "summary": "Clear 2-3 sentence assessment of the product in ${languageName}."
  },
  "ui": {
    "title": "Názov produktu",
    "ingredients_title": "Zloženie",
    "additives_title": "Prídavné látky (E-čka)",
    "summary_title": "Zhodnotenie"
  }
}

Write all user-facing strings strictly in ${languageName}. No markdown, no HTML wrappers. Return STRICT JSON.
`;
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
  res.sendFile(path.join(__dirname, "../frontend/index.html"));
});

app.post("/api/scan", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Chyba priloha 'image' vo FormData." });
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

    const content = extractText(completion?.choices?.[0]?.message?.content);
    if (!content) {
      return res.status(502).json({ error: "OpenAI nevratil ziadny content." });
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      return res.status(502).json({ error: `Neplatna JSON odpoved od OpenAI: ${err.message}` });
    }

    if (parsed?.error) {
      return res.status(422).json({ error: parsed.error });
    }

    return res.json(parsed);
  } catch (err) {
    console.error("[/api/scan] OpenAI/API chyba:", err);
    return res.status(502).json({ error: String(err?.message || err) });
  }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `Chyba uploadu: ${err.message}` });
  }
  if (err) {
    return res.status(400).json({ error: err.message || "Neznama chyba." });
  }
  next();
});

app.listen(PORT, () => {
  console.log(`Food Scanner backend bezi na http://localhost:${PORT}`);
});
