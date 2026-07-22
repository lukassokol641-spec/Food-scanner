require("dotenv").config();
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const OpenAI = require("openai");

let openai;
if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

const app = express();
const PORT = process.env.PORT || 4000;

const CACHE_FILE = path.join(__dirname, "scan_cache.json");
let scanCache = {};

if (fs.existsSync(CACHE_FILE)) {
  try {
    scanCache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch (e) {
    scanCache = {};
  }
}

app.use(express.json({ limit: "2mb" }));
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, "../frontend")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }
});

function normalizeName(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, hasApiKey: Boolean(process.env.OPENAI_API_KEY) });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.post("/api/scan", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Chýba fotka." });
    if (!openai) return res.status(500).json({ error: "Chýba API kľúč." });

    const lang = ["sk", "en", "de"].includes(req.body?.lang) ? req.body.lang : "sk";
    const mimeType = req.file.mimetype || "image/jpeg";
    const base64Image = req.file.buffer.toString("base64");

    // Rýchly a optimalizovaný prompt
    const systemPrompt = `Analyze food package label. Translate response strictly to ${lang === "sk" ? "Slovak" : lang === "en" ? "English" : "German"}.
Return JSON strictly:
{
  "scan": { "status": "success", "language": "${lang}", "highlights": [] },
  "product": { "name": "Product Name", "category": "Category", "portion": "Size" },
  "analysis": {
    "verdict": { "score": 70, "severity": "orange", "label": "Radšej obmedziť / Výborná voľba" },
    "recommendation": "Short evaluation 2 sentences.",
    "scores": {
      "sugar": { "value": "0g / 100g", "level": "Nízky", "severity": "green" },
      "salt": { "value": "1.5g / 100g", "level": "Vyšší", "severity": "orange" },
      "additives": { "value": "E-numbers info", "level": "Pozor", "severity": "orange" },
      "processing": { "value": "Spracovaná potravina", "level": "Mierne vyššie", "severity": "orange" }
    },
    "healthierSwap": {
      "enabled": true,
      "summary": "Healthier alternative tip",
      "improvement": "+15 bodov",
      "product": { "name": "Better alternative", "score": 85, "sugar": "0g", "salt": "0.5g", "additives": "Bez E-čiek", "processing": "Minimálne" }
    }
  },
  "ui": { "mode": "live", "progressTitle": "Hotovo", "progressText": "Analýza dokončená.", "ocrStatus": "Hotovo" }
}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.1,
      max_tokens: 600, // Znížené pre oveľa rýchlejšiu odozvu
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: [{ type: "image_url", image_url: { url: `data:${mimeType};base64,${base64Image}` } }] }
      ]
    });

    const parsed = JSON.parse(completion.choices[0].message.content);
    const prodKey = normalizeName(parsed?.product?.name) + "_" + lang;

    // Ak už tento názov produktu máme v databáze, vrátime uloženú verziu
    if (scanCache[prodKey]) {
      const cached = scanCache[prodKey];
      cached.ui.progressText = "⚡ Bleskovo načítané z pamäte (Cache)";
      return res.json(cached);
    }

    // Uloženie nového produktu
    if (prodKey.length > 3) {
      scanCache[prodKey] = parsed;
      try { fs.writeFileSync(CACHE_FILE, JSON.stringify(scanCache, null, 2)); } catch (e) {}
    }

    return res.json(parsed);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: String(err?.message || err) });
  }
});

app.listen(PORT, () => console.log(`Server beží na portu ${PORT}`));
