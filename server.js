require("dotenv").config();
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const OpenAI = require("openai");

let openai;
if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
} else {
  console.warn("[WARN] OPENAI_API_KEY chyba v .env.");
}

const app = express();
const PORT = process.env.PORT || 4000;

// Súbor pre trvalé ukladanie vyrovnávacej pamäte na disk
const CACHE_FILE = path.join(__dirname, "scan_cache.json");

// Načítanie cache z disku pri štarte servera
let scanCache = {};
if (fs.existsSync(CACHE_FILE)) {
  try {
    scanCache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    console.log(`[CACHE] Načítaných ${Object.keys(scanCache).length} produktov z pamäte.`);
  } catch (e) {
    console.error("[CACHE] Chyba pri čítaní scan_cache.json:", e);
    scanCache = {};
  }
}

app.use(express.json({ limit: "2mb" }));
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, "../frontend")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) return cb(new Error("Iba obrázkové formáty sú povolené."));
    cb(null, true);
  }
});

function buildPrompt(lang) {
  const languageName = { sk: "Slovak", en: "English", de: "German" }[(["sk", "en", "de"].includes(lang) ? lang : "sk")];
  
  return `Analyze this food package or label image and return STRICT JSON only.
The printed text may be in Swedish, German, Polish, Slovak, English, or any European language.
Perform precise OCR and translate all output texts into ${languageName}.

Return a JSON object with this EXACT structure:
{
  "scan": {
    "status": "success",
    "language": "${lang}",
    "highlights": [
      { "x": 10, "y": 20, "w": 30, "h": 15, "label": "E211 / Cukor", "severity": "danger" }
    ]
  },
  "product": {
    "name": "Exact product name as found on package",
    "category": "Product category",
    "portion": "Package size"
  },
  "analysis": {
    "verdict": {
      "score": 65,
      "severity": "orange",
      "label": "Radšej obmedziť / Výborná voľba"
    },
    "recommendation": "Detailed evaluation of ingredients and additives in ${languageName}.",
    "scores": {
      "sugar": { "value": "12g / 100g", "level": "Stredný", "severity": "orange" },
      "salt": { "value": "0.8g / 100g", "level": "Nízky", "severity": "green" },
      "additives": { "value": "2 prídavné látky", "level": "Pozor", "severity": "orange" },
      "processing": { "value": "Spracovaná potravina", "level": "Mierne vyššie", "severity": "orange" }
    },
    "healthierSwap": {
      "enabled": true,
      "summary": "Healthier choice summary",
      "improvement": "+20 bodov",
      "product": {
        "name": "Healthier alternative name",
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
Write all string values strictly in ${languageName}. No markdown. Return STRICT JSON.`;
}

function extractText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(p => p?.text || "").join("\n");
  return "";
}

// Pomocná funkcia na vytvorenie kľúča z nazvu/bufferu
function getCacheKey(buffer) {
  // Zjednodušený hash obrázka podľa dĺžky a vzorky dát
  const head = buffer.slice(0, 100).toString("hex");
  const tail = buffer.slice(-100).toString("hex");
  return `${buffer.length}_${head}_${tail}`;
}

app.get("/api/health", (req, res) => {
  res.json({ 
    ok: true, 
    hasApiKey: Boolean(process.env.OPENAI_API_KEY),
    cachedItems: Object.keys(scanCache).length 
  });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.post("/api/scan", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Chýba príloha 'image' vo FormData." });
    }

    const lang = ["sk", "en", "de"].includes(req.body?.lang) ? req.body.lang : "sk";
    const cacheKey = `${getCacheKey(req.file.buffer)}_${lang}`;

    // ⚡ SKONTROLUJ CACHE: Ak produkt pozname, vratime zapamätany vysledok!
    if (scanCache[cacheKey]) {
      console.log(`[CACHE HIT] Produkt nájdený v pamäti! Ušetrené volanie OpenAI.`);
      const cachedResult = scanCache[cacheKey];
      cachedResult.ui.progressText = "Naskenované z rýchlej pamäte (Cache).";
      return res.json(cachedResult);
    }

    if (!openai) {
      return res.status(500).json({ error: "OPENAI_API_KEY chyba na serveri." });
    }

    console.log(`[OPENAI CALL] Produkt nie je v pamäti, odosielam na GPT-4o Vision...`);
    const mimeType = req.file.mimetype || "image/jpeg";
    const base64Image = req.file.buffer.toString("base64");

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are an expert food label analysis engine. Extract text, translate all findings to ${lang === "sk" ? "Slovak" : lang === "en" ? "English" : "German"}, and return ONLY valid JSON matching schema.`
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

    // 💾 ULOŽENIE DO CACHE pre budúce použitie
    scanCache[cacheKey] = parsed;
    try {
      fs.writeFileSync(CACHE_FILE, JSON.stringify(scanCache, null, 2));
    } catch (e) {
      console.error("[CACHE SAVE ERROR]", e);
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
  console.log(`Food Scanner backend beží na porte ${PORT}`);
});
