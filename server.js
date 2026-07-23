const express = require('express');
const multer = require('multer');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// Inicializácia Supabase klienta
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

app.use(express.json());
app.use(express.static(__dirname));

// --- Pomocná funkcia na vytvorenie kľúča produktu ---
function makeSafeKey(text) {
  if (!text) return 'produkt_' + Date.now();
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .trim();
}

// --- API ENDPOINT PRE AI SKENOVANIE ETIKETY ---
app.post('/api/scan', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nebol nahraný žiadny obrázok.' });
    }

    const lang = req.body.lang || 'sk';
    const profile = req.body.profile || 'general';
    const allergens = JSON.parse(req.body.allergens || '[]');

    const base64Image = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype;

    const prompt = `
Si expert na výživu, chemické zloženie a čítanie obalov potravín a nápojov. Analýzuj priloženú fotku obalu/etikety a vráť STRIKTNE iba platný JSON objekt (bez Markdown obalu) v tomto presnom formáte:

{
  "product": {
    "name": "Názov produktu",
    "category": "Kategória (napr. Alkoholický nápoj / Pivo)",
    "portion": "Veľkosť balenia / porcia"
  },
  "lactose_g": 0,
  "contains_alcohol": true,
  "alcohol_percentage": "3.5%",
  "allergen_warnings": ["Alkohol", "Laktóza"],
  "ingredients_raw": "Zoznam surovín vytiahnutý z fotky (alebo odvodený z typu nápoja)...",
  "energy_impact": {
    "type": "spike",
    "title": "Titulok dopadu na energiu",
    "description": "Stručný popis dopadu",
    "duration": "~45 min"
  },
  "additives_detail": [],
  "analysis": {
    "verdict": {
      "score": 30,
      "label": "Nevhodné pri intolerancii",
      "severity": "red"
    },
    "recommendation": "Stručné odporúčanie pre užívateľa",
    "scores": {
      "sugar": { "value": "3.8g", "level": "Nízky", "severity": "green" },
      "salt": { "value": "0g", "level": "Nízky", "severity": "green" },
      "additives": { "value": "0 aditív", "level": "Čisté", "severity": "green" },
      "processing": { "value": "Kvasenie", "level": "Stredné", "severity": "orange" }
    },
    "healthierSwap": {
      "enabled": false,
      "improvement": "+40 bodov",
      "summary": "Nealkoholické pivo / Nealko alternatíva",
      "product": {
        "name": "Birell Nealko",
        "score": 85,
        "sugar": "2g",
        "salt": "0g",
        "additives": "Bez E-čiek",
        "processing": "Minimálne"
      }
    }
  }
}

KRITICKÉ PRAVIDLÁ PRE DETEKCIU ALKOHOLU A ALERGÉNOV:
1. AK IDE O PIVO, VÍNO, CIDER, LIHOVINU ALEBO RADLER S ALKOHOLOM:
   - Aj keď na obale nie je zloženie alebo slovo "alkohol" výslovne napísané v ingredienciách, ZISTI percentá alkoholu z obalu (napr. 3.5%, 5%, 12%) alebo z nápadov/značky.
   - Považuj ALKOHOL automaticky za prítomný!
   - Ak užívateľ zadal vo filtroch/alergénoch "alkohol", alebo má intoleranciu, OKAMŽITE pridaj "Alkohol" do "allergen_warnings" a do "verdict" daj nízke skóre a červenú varovnú farbu ("severity": "red")!
2. Všetky texty musia byť v jazyku: ${lang}.
3. Užívateľský profil: ${profile}.
4. Užívateľ sa chce vyhnúť týmto zložkám/alergénom: ${allergens.join(', ')}.
5. Ak produkt obsahuje laktózu, uveď g do "lactose_g". Ak neobsahuje, daj 0.
6. Vráť IBA čistý JSON!
`;

    // 1. Zavolanie OpenAI Vision API
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mimeType};base64,${base64Image}`
                }
              }
            ]
          }
        ],
        max_tokens: 1000
      })
    });

    const aiData = await response.json();
    let rawText = aiData.choices?.[0]?.message?.content || '{}';
    rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
    
    const jsonResult = JSON.parse(rawText);
    const productKey = makeSafeKey(jsonResult.product?.name);
    jsonResult.product_key = productKey;

    // 2. Uloženie do Supabase
    if (supabase) {
      try {
        await supabase.from('products').upsert({
          product_key: productKey,
          data: jsonResult,
          updated_at: new Date()
        });
      } catch (dbErr) {
        console.error('Chyba pri zápise do Supabase:', dbErr);
      }
    }

    res.json(jsonResult);

  } catch (error) {
    console.error('Chyba pri AI analýze:', error);
    res.status(500).json({ error: 'Chyba pri spracovaní fotky na serveri.' });
  }
});

// --- API ENDPOINT PRE RECENZIE (SUPABASE) ---
app.get('/api/reviews', async (req, res) => {
  const { key } = req.query;
  if (!key) return res.json([]);

  if (supabase) {
    const { data, error } = await supabase
      .from('reviews')
      .select('*')
      .eq('product_key', key)
      .order('created_at', { ascending: false });

    if (!error && data) return res.json(data);
  }

  res.json([]);
});

app.post('/api/reviews', async (req, res) => {
  const { productKey, rating, comment } = req.body;

  if (supabase) {
    const { error } = await supabase.from('reviews').insert([
      { product_key: productKey, rating: parseInt(rating), comment }
    ]);

    if (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }
    return res.json({ ok: true });
  }

  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server beží na porte ${PORT}`);
});
