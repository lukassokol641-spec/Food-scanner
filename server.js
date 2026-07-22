require("dotenv").config();
const express = require("express");
const multer = require("multer");
const path = require("path");
const OpenAI = require("openai");
const { createClient } = require("@supabase/supabase-js");

let openai;
if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// Prepojenie na Supabase Cloud Databázu
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  console.log("[SUPABASE] Cloudová databáza úspešne pripojená.");
} else {
  console.warn("[WARN] SUPABASE_URL alebo SUPABASE_KEY chýba v prostredí.");
}

const app = express();
const PORT = process.env.PORT || 4000;

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
  res.json({
    ok: true,
    hasApiKey: Boolean(process.env.OPENAI_API_KEY),
    hasSupabase: Boolean(supabase)
  });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// API pre získanie recenzií k produktu
app.get("/api/reviews/:productKey", async (req, res) => {
  if (!supabase) return res.json([]);
  try {
    const { data, error } = await supabase
      .from("reviews")
      .select("*")
      .eq("product_key", req.params.productKey)
      .order("created_at", { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("[REVIEWS GET ERROR]", err);
    res.status(500).json({ error: "Chyba pri načítaní recenzií." });
  }
});

// API pre pridanie novej recenzie
app.post("/api/reviews", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Cloud databáza nie je pripojená." });
  try {
    const { productKey, rating, comment } = req.body;
    if (!productKey || !rating) return res.status(400).json({ error: "Chýba hodnotenie." });

    const { data, error } = await supabase
      .from("reviews")
      .insert([{ product_key: productKey, rating: Number(rating), comment: comment || "" }])
      .select();

    if (error) throw error;
    res.json({ ok: true, review: data[0] });
  } catch (err) {
    console.error("[REVIEWS POST ERROR]", err);
    res.status(500).json({ error: "Chyba pri ukladaní recenzie." });
  }
});

// Hlavné API skenovania s okamžitou Cloud Cache
app.post("/api/scan", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Chýba fotka." });
    if (!openai) return res.status(500).json({ error: "Chýba API kľúč pre OpenAI." });

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
    "type": "spike",
    "title": "Prudký výkyv cukru a skorá únava",
    "description": "Tento produkt spôsobuje rýchly nárast glukózy a pád. Možný Brain Fog.",
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
    parsed.product_key = prodKey;

    // 1. SKONTROLUJ CLOUD DATABÁZU SUPABASE
    if (supabase && prodKey.length > 3) {
      const { data: dbProduct } = await supabase
        .from("products")
        .select("data")
        .eq("product_key", prodKey)
        .single();

      if (dbProduct && dbProduct.data) {
        console.log(`[SUPABASE CACHE HIT] Produkt načítaný z cloudu pre klienta!`);
        return res.json(dbProduct.data);
      }
    }

    // 2. ULOŽ NOVÝ PRODUKT DO CLOUDU
    if (supabase && prodKey.length > 3) {
      await supabase.from("products").insert([
        { product_key: prodKey, name: parsed.product?.name, data: parsed }
      ]);
      console.log(`[SUPABASE SAVE] Nový produkt uložený do globálnej databázy.`);
    }

    return res.json(parsed);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: String(err?.message || err) });
  }
});

app.listen(PORT, () => console.log(`Server beží na porte ${PORT}`));
