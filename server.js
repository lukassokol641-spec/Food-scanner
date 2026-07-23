const express = require('express');
const multer = require('multer');
const path = require('path');
require('dotenv').config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.static(__dirname));

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
- DÔLEŽITÉ: Ak produkt obsahuje laktózu alebo mliečne zložky, do políčka "lactose_g" uveď presné gramy laktózy na 100g (ak nie sú uvedené presne, odhadni ich z obsahu cukrov). Ak produkt laktózu neobsahuje, daj 0.
- Ak v produkte nájdeš zakázaný alergén (${allergens.join(', ')}), uveď ho do "allergen_warnings".
- Vráť IBA čistý JSON!
`;

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
    
    // Očistenie od markdown obalov
    rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
    
    const jsonResult = JSON.parse(rawText);
    res.json(jsonResult);

  } catch (error) {
    console.error('Chyba pri AI analýze:', error);
    res.status(500).json({ error: 'Chyba pri spracovaní fotky na serveri.' });
  }
});

// Mock recenzie
app.get('/api/reviews', (req, res) => {
  res.json([]);
});

app.post('/api/reviews', (req, res) => {
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server beží na porte ${PORT}`);
});
