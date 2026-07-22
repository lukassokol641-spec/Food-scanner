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
  try { scanCache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch (e) { scanCache = {}; }
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

    const systemPrompt = `Analyze food package label. Translate response strictly to ${lang === "sk" ? "Slovak" : lang === "en" ? "English" : "German"}.
Return JSON strictly with energy impact data:
{
  "scan": { "status": "success", "language": "${lang}" },
  "product": { "name": "Exact product name", "category": "Category", "portion": "Size" },
  "ingredients_raw": "Vyber a prelož celý text zloženia z obalu",
  "additives_detail": [
    {
      "code": "E250",
      "name": "Dusitan sodný",
      "origin": "Syntetická soľ",
      "process": "Konzervant proti baktériám.",
      "risk": "Záťaž pri vysokých teplotách."
    }
  ],
  "energy_impact": {
    "type": "spike", // Možnosti: "spike" (prudký výkyv/únava) alebo "stable" (stabilná energia)
    "title": "Prudký výkyv cukru a skorá únava",
    "description": "Tento produkt spôsobuje rýchly nárast glukózy, po ktorom do 45 minút nasleduje pád. Možný Brain Fog a chuť na ďalšie jedlo.",
    "duration": "Podpora energie: ~30-45 min"
  },
  "analysis": {
    "verdict": { "score": 65, "severity": "orange", "label": "Radšej obmedziť" },
    "recommendation": "Stručné 2-vetové zhodnotenie.",
    "scores": {
      "sugar": { "value": "0g / 100g", "level": "Nízky", "severity": "green" },
      "salt": { "value": "2g / 100g", "level": "Vyšší", "severity": "orange" },
      "additives": { "value": "2 E-čka", "level": "Pozor", "severity": "orange" },
      "processing": { "value": "Spracovaná potravina", "level": "Mierne vyššie", "severity": "orange" }
    },
    "healthierSwap": {
      "enabled": true,
      "summary": "Stabilnejšia alternatíva bez výkyvov energie.",
      "improvement": "+20 bodov",
      "product": { "name": "Čerstvé mäso / orechy", "score": 85, "sugar": "0g", "salt": "0.1g", "additives": "Bez E-čiek", "processing": "Minimálne" }
    }
  }
}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.1,
      max_tokens: 900,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: [{ type: "image_url", image_url: { url: `data:${mimeType};base64,${base64Image}` } }] }
      ]
    });

    const parsed = JSON.parse(completion.choices[0].message.content);
    const prodKey = normalizeName(parsed?.product?.name) + "_" + lang;

    if (scanCache[prodKey]) {
      return res.json(scanCache[prodKey]);
    }

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

app.listen(PORT, () => console.log(`Server beží na porte ${PORT}`));
