require("dotenv").config();
const express = require("express");
const multer = require("multer");
const path = require("path");
const OpenAI = require("openai");

let openai;
if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

let supabase = null;
try {
  let rawUrl = process.env.SUPABASE_URL || "";
  let cleanUrl = rawUrl.trim().replace(/\/rest\/v1\/?$/, "").replace(/\/+$/, "");

  if (cleanUrl && process.env.SUPABASE_KEY) {
    const { createClient } = require("@supabase/supabase-js");
    supabase = createClient(cleanUrl, process.env.SUPABASE_KEY.trim());
    console.log("[SUPABASE] Cloudová databáza pripojená na:", cleanUrl);
  }
} catch (e) {
  console.warn("[WARN] Supabase zlyhalo:", e.message);
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

function makeSafeKey(text) {
  if (!text) return "produkt_" + Date.now();
  return String(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_")
    .replace(/_+/g, "_")
    .trim();
}

const LANG_MAP = {
  sk: "Slovak", cz: "Czech", pl: "Polish", hu: "Hungarian",
  en: "English", de: "German", it: "Italian", fr: "French", es: "Spanish"
};

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

// GET recenzie
app.get("/api/reviews", async (req, res) => {
  if (!supabase) return res.json([]);
  try {
    const rawKey = req.query.key || "";
    const targetLang = LANG_MAP[req.query.lang] || "Slovak";
    const cleanKey = makeSafeKey(rawKey);

    const { data, error } = await supabase
      .from("reviews")
      .select("*")
      .eq("product_key", cleanKey)
      .order("created_at", { ascending: false });

    if (error || !data || data.length === 0) return res.json([]);

    if (!openai || req.query.lang === "sk") return res.json(data);

    const prompt = `Translate user food reviews to ${targetLang}. Preserve rating and structure. Return JSON object with array 'reviews': [{ "id": 1, "comment": "text" }].
Reviews: ${JSON.stringify(data.map(r => ({ id: r.id, comment: r.comment })))}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: prompt }]
    });

    const parsed = JSON.parse(completion.choices[0].message.content);
    const translatedList = parsed.reviews || parsed.items || Object.values(parsed)[0] || [];

    const finalReviews = data.map(orig => {
      const trans = Array.isArray(translatedList) ? translatedList.find(t => t.id === orig.id) : null;
      return { ...orig, comment: trans?.comment || orig.comment };
    });

    res.json(finalReviews);
  } catch (err) {
    res.json([]);
  }
});

// POST recenzia
app.post("/api/reviews", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Supabase nie je pripojená." });
  try {
    const { productKey, rating, comment } = req.body;
    const cleanKey = makeSafeKey(productKey);

    const { data, error } = await supabase
      .from("reviews")
      .insert([{ product_key: cleanKey, rating: Number(rating) || 5, comment: comment || "" }])
      .select();

    if (error) return res.status(400).json({ error: error.message });
    res.json({ ok: true, review: data?.[0] });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// Hlavný AI sken s profilmi a alergénmi
app.post("/api/scan", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Chýba fotka." });
    if (!openai) return res.status(500).json({ error: "Chýba API kľúč pre OpenAI." });

    const langKey = req.body?.lang || "sk";
    const targetLang = LANG_MAP[langKey] || "Slovak";
    const profile = req.body?.profile || "general";
    const userAllergens = req.body?.allergens ? JSON.parse(req.body.allergens) : [];
    
    const mimeType = req.file.mimetype || "image/jpeg";
    const base64Image = req.file.buffer.toString("base64");

    let profileContext = "General health evaluation.";
    if (profile === "heart") {
      profileContext = "USER PROFILE: Heart & Blood Pressure Focus. Be extremely strict on high SALT and SODIUM.";
    } else if (profile === "diabetes") {
      profileContext = "USER PROFILE: Diabetes / Blood Sugar Focus. Be extremely strict on ADDED SUGARS and carb spikes.";
    } else if (profile === "clean") {
      profileContext = "USER PROFILE: Clean Eating / No Additives. Be extremely strict on ADDITIVES and E-numbers.";
    }

    let allergenContext = "";
    if (userAllergens.length > 0) {
      allergenContext = `CRITICAL CHECK: User avoids these items: ${userAllergens.join(", ")}. If present in ingredients, list them strictly in 'allergen_warnings' in ${targetLang}.`;
    }

    const systemPrompt = `Analyze food package label. Translate response strictly to ${targetLang}.
${profileContext}
${allergenContext}

Return JSON strictly:
{
  "scan": { "status": "success", "language": "${langKey}" },
  "product": { "name": "Exact product name", "category": "Category", "portion": "Size" },
  "allergen_warnings": [], // Array of detected forbidden ingredients/allergens in ${targetLang} (e.g. ["Laktóza", "Palmový olej"])
  "ingredients_raw": "Vyber a prelož celý text zloženia z obalu do ${targetLang}",
  "additives_detail": [
    {
      "code": "E250",
      "name": "Názov látky",
      "origin": "Pôvod",
      "process": "Ako sa vyrába",
      "risk": "Riziko pre zdravie"
    }
  ],
  "energy_impact": {
    "type": "spike", // strictly: "spike", "moderate", or "stable"
    "title": "Názov dopadu na energiu",
    "description": "Detailný popis správania glukózy a sústredenia v reči ${targetLang}.",
    "duration": "Podpora energie: napr. ~45 min"
  },
  "analysis": {
    "verdict": { "score": 65, "severity": "orange", "label": "Text verdiktu" },
    "recommendation": "Stručné zhodnotenie s ohľadom na profil v reči ${targetLang}.",
    "scores": {
      "sugar": { "value": "0g / 100g", "level": "Nízky", "severity": "green" },
      "salt": { "value": "2g / 100g", "level": "Vyšší", "severity": "orange" },
      "additives": { "value": "2 E-čka", "level": "Pozor", "severity": "orange" },
      "processing": { "value": "Spracovaná potravina", "level": "Mierne vyššie", "severity": "orange" }
    },
    "healthierSwap": {
      "enabled": true,
      "summary": "Zdravšia alternatíva",
      "improvement": "+20 bodov",
      "product": { "name": "Názov alternatívy", "score": 85, "sugar": "0g", "salt": "0.1g", "additives": "Bez E-čiek", "processing": "Minimálne" }
    }
  }
}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.1,
      max_tokens: 980,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: [{ type: "image_url", image_url: { url: `data:${mimeType};base64,${base64Image}` } }] }
      ]
    });

    const parsed = JSON.parse(completion.choices[0].message.content);
    const safeAllergens = userAllergens.sort().join("_");
    const prodKey = makeSafeKey(parsed?.product?.name) + "_" + langKey + "_" + profile + "_" + safeAllergens;
    parsed.product_key = prodKey;

    if (supabase && prodKey.length > 3) {
      try {
        const { data: dbProduct } = await supabase
          .from("products")
          .select("data")
          .eq("product_key", prodKey)
          .single();

        if (dbProduct && dbProduct.data) return res.json(dbProduct.data);
      } catch (e) {}
    }

    if (supabase && prodKey.length > 3) {
      try {
        await supabase.from("products").insert([
          { product_key: prodKey, name: parsed.product?.name, data: parsed }
        ]);
      } catch (e) {}
    }

    return res.json(parsed);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: String(err?.message || err) });
  }
});

app.listen(PORT, () => console.log(`Server beží na porte ${PORT}`));
