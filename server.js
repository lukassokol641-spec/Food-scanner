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
Si expert na výživu a čítanie obalov potravín. Analýzuj priloženú fotku etikety potraviny a vráť STRIKTNE iba platný JSON objekt (bez Markdown obalu) v tomto presnom formáte:

{
  "product": {
    "name": "Názov produktu",
    "category": "Kategória (napr. Mliečne výrobky)",
    "portion": "Veľkosť balenia / porcia"
  },
  "lactose_g": 4.8,
  "allergen_warnings": ["Laktóza", "Mlieko"],
  "ingredients_raw": "Zoznam surovín vytiahnutý z fotky...",
  "energy_impact": {
    "type": "spike",
    "title": "Titulok dopadu na energiu",
    "description": "Stručný popis dopadu na glukózu",
    "duration": "~45 min"
  },
  "additives_detail": [
    {
      "code": "E471",
      "name": "Mono- a diglyceridy mastných kyselín",
      "origin": "Rastlinný/Živočíšny",
      "process": "Emulgátor",
      "risk": "Bezpečné"
    }
  ],
  "analysis": {
    "verdict": {
      "score": 75,
      "label": "Radšej obmedziť",
      "severity": "orange"
    },
    "recommendation": "Stručné odporúčanie pre užívateľa",
    "scores": {
      "sugar": { "value": "4.8g", "level": "Nízky", "severity": "green" },
      "salt": { "value": "0.1g", "level": "Nízky", "severity": "green" },
      "additives": { "value": "0 aditív", "level": "Čisté", "severity": "green" },
      "processing": { "value": "Minimálne", "level": "Dobré", "severity": "green" }
    },
    "healthierSwap": {
      "enabled": false,
      "improvement": "+15 bodov",
      "summary": "Popis zdravšej alternatívy",
      "product": {
        "name": "Názov alternatívy",
        "score": 90,
        "sugar": "0g",
        "salt": "0.1g",
        "additives": "Bez E-čiek",
        "processing": "Minimálne"
      }
    }
  }
}

Pravidlá pre AI:
- Všetky texty musia byť v jazyku: ${lang}.
- Užívateľský profil: ${profile}.
- Užívateľ sa chce vyhnúť týmto zložkám/alergénom: ${allergens.join(', ')}.
- DÔLEŽITÉ: Ak produkt obsahuje laktózu alebo mliečne zložky, do políčka "lactose_g" uveď presné gramy laktózy na 100g. Ak neobsahuje, uveď 0.
- Ak v produkte nájdeš zakázaný alergén (${allergens.join(', ')}), uveď ho do "allergen_warnings".
- Vráť IBA čistý JSON!
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

    // 2. Uloženie do Supabase (ak je Supabase nakonfigurovaná)
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
