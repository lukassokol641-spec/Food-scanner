import express from 'express';
import multer from 'multer';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.use(express.json());
app.use(express.static(__dirname));

const reviewsDb = {};

// 1. ENDPOINT PRE SKENOVANIE POTRAVÍN
app.post('/api/scan', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nebol odoslaný žiadny obrázok.' });

    const lang = req.body.lang || 'sk';
    const profile = req.body.profile || 'general';
    const allergens = req.body.allergens ? JSON.parse(req.body.allergens) : [];
    const imageBase64 = req.file.buffer.toString('base64');

    const promptText = `
Analýzuj túto etiketu potraviny/nápoja.
Používateľský jazyk: ${lang}
Zdravotný profil používateľa: ${profile}
Zakázané alergény/zložky pre používateľa: ${allergens.join(', ')}

Vráť výsledok STRICTNE ako čistý JSON s touto štruktúrou:
{
  "product": { "name": "Názov produktu", "category": "Kategória", "portion": "Porcia (napr. 100g)" },
  "lactose_g": 0.0,
  "allergen_warnings": ["Zoznam varovaní ak produkt obsahuje vybrané zakázané zložky alebo alkohol"],
  "ingredients_raw": "Prečítané zloženie z obalu",
  "additives_detail": [ { "code": "E300", "name": "Názov", "origin": "Pôvod", "process": "Spôsob výroby", "risk": "Zdravotný vplyv" } ],
  "energy_impact": { "type": "spike" | "moderate" | "steady", "title": "Názov efektu", "description": "Opis glukózového efektu", "duration": "~X min" },
  "analysis": {
    "verdict": { "score": 75, "label": "Skóre a hodnotenie", "severity": "green" | "orange" | "red" },
    "recommendation": "Odporúčanie",
    "scores": {
      "sugar": { "value": "X g", "level": "Nízky/Vysoký", "severity": "green" },
      "salt": { "value": "X g", "level": "Nízky/Vysoký", "severity": "green" },
      "additives": { "value": "X aditív", "level": "Bez E-čiek", "severity": "green" },
      "processing": { "value": "Stupeň spracovania", "level": "Nízky", "severity": "green" }
    },
    "healthierSwap": {
      "enabled": true,
      "improvement": "+15 bodov",
      "summary": "Stručné zhrnutie prečo je lepšia",
      "product": { "name": "Názov alternatívy", "score": 90, "sugar": "X g", "salt": "X g", "additives": "Bez E-čiek", "processing": "Minimálne" }
    }
  }
}
`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: [{ type: "text", text: promptText }, { type: "image_url", image_url: { url: `data:${req.file.mimetype};base64,${imageBase64}` } }] }],
      response_format: { type: "json_object" }
    });

    res.json(JSON.parse(response.choices[0].message.content));
  } catch (error) {
    res.status(500).json({ error: 'Chyba pri spracovaní obrázka.' });
  }
});

// 2. ENDPOINT PRE SKENER LEKÁRSKYCH SPRÁV
app.post('/api/scan-medical', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nebol odoslaný žiadny obrázok.' });

    const lang = req.body.lang || 'sk';
    const imageBase64 = req.file.buffer.toString('base64');

    const promptText = `
Analýzuj tento lekársky nález, lekársku správu alebo krvné testy.
Výstup vráť STRICTNE ako čistý JSON v jazyku: ${lang}.

Formát JSON odpovede:
{
  "summary": "Stručné a zrozumiteľné zhrnutie správy ľudskou rečou bez zložitej latinčiny.",
  "diagnoses": ["Zoznam hlavných diagnóz alebo nálezov"],
  "blood_markers": [ { "name": "Názov parametra", "value": "Hodnota", "status": "normal" | "high" | "low", "note": "Vysvetlenie" } ],
  "dietary_recommendations": ["Odporúčania pre stravu"],
  "suggested_profile": "general" | "heart" | "diabetes" | "clean",
  "suggested_allergens": ["gluten", "lactose", "nuts", "palmoil"]
}
`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: [{ type: "text", text: promptText }, { type: "image_url", image_url: { url: `data:${req.file.mimetype};base64,${imageBase64}` } }] }],
      response_format: { type: "json_object" }
    });

    res.json(JSON.parse(response.choices[0].message.content));
  } catch (error) {
    res.status(500).json({ error: 'Chyba pri spracovaní lekárskej správy.' });
  }
});

// 3. ENDPOINT PRE AKČNÉ ZĽAVY V PREDAJNIACH
app.post('/api/discounts', async (req, res) => {
  try {
    const { city, stores, shoppingList, lang } = req.body;
    if (!city || !stores || stores.length === 0 || !shoppingList || shoppingList.length === 0) {
      return res.status(400).json({ error: 'Chýbajú parametre pre kontrolu letákov.' });
    }

    const promptText = `
Si nákupný asistent pre akčné ponuky na Slovensku.
Mesto používateľa: ${city}
Vybrané predajne: ${stores.join(', ')}
Nákupný zoznam: ${JSON.stringify(shoppingList)}
Jazyk: ${lang || 'sk'}

Vráť STRICTNE čistý JSON:
{
  "city": "${city}",
  "recommendations": ["Odporúčania kde čo kúpiť najvýhodnejšie"],
  "discounted_items": [ { "product_name": "Položka zo zoznamu", "store": "Obchod", "discount_price": "1.29 €", "original_price": "1.89 €", "saving_percent": "-31%" } ]
}
`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: promptText }],
      response_format: { type: "json_object" }
    });

    res.json(JSON.parse(response.choices[0].message.content));
  } catch (error) {
    res.status(500).json({ error: 'Chyba pri vyhľadávaní zliav.' });
  }
});

// 4. ENDPOINT PRE DENNÉ MENU A REŠTAURÁCIE
app.post('/api/daily-menu', async (req, res) => {
  try {
    const { city, profile, allergens, currentTime, medicalNotes, lang } = req.body;
    const userCity = city || "Revúca";

    const promptText = `
Si gastro asistent pre denné menu a reštaurácie na Slovensku.
Mesto: ${userCity}
Aktuálny čas používateľa: ${currentTime || "12:00"}
Zdravotný profil používateľa: ${profile || "general"}
Zakázané alergény/zložky: ${(allergens || []).join(', ')}
Poznámky z lekárskej správy: ${medicalNotes || "Žiadne špeciálne obmedzenia"}
Jazyk: ${lang || 'sk'}

Zisti/simuluj aktuálne reštaurácie a denné obedové menu pre dané mesto na Slovensku.
Ak je čas medzi 10:30 a 14:30, zameraj sa na Denné obedové menu.
Ak je mimo týchto hodín, zameraj sa na stálu ponuku a otváracie hodiny reštaurácií v okolí.

Vráť STRICTNE čistý JSON:
{
  "mode": "lunch_menu" | "regular_menu",
  "city": "${userCity}",
  "time_info": "Text informujúci o aktuálnom režime (napr. Obedové menu 11:00 - 14:00)",
  "restaurants": [
    {
      "name": "Názov reštaurácie",
      "address": "Ulica / Lokalita",
      "serving_hours": "11:00 - 13:30",
      "menu_items": [
        {
          "title": "Názov jedla (napr. Grilované kuracie prsia s ryžou)",
          "price": "6.50 €",
          "is_suitable": true | false,
          "warning": "Dôvod ak nie je vhodné (napr. Obsahuje laktózu)",
          "health_score": "Výborná voľba / Mierne rizikové / Nevhodné"
        }
      ]
    }
  ]
}
`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: promptText }],
      response_format: { type: "json_object" }
    });

    res.json(JSON.parse(response.choices[0].message.content));
  } catch (error) {
    console.error('Chyba pri hľadaní denného menu:', error);
    res.status(500).json({ error: 'Chyba pri vyhľadávaní reštaurácií.' });
  }
});

// 5. ENDPOINTY PRE RECENZIE
app.get('/api/reviews', (req, res) => {
  const key = req.query.key || 'general';
  res.json(reviewsDb[key] || []);
});

app.post('/api/reviews', (req, res) => {
  const { productKey, rating, comment } = req.body;
  if (!productKey || !comment) return res.status(400).json({ error: 'Chýbajú povinné údaje.' });
  if (!reviewsDb[productKey]) reviewsDb[productKey] = [];
  const newReview = { rating: parseInt(rating) || 5, comment, created_at: new Date().toISOString() };
  reviewsDb[productKey].unshift(newReview);
  res.json({ ok: true, review: newReview });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server beží na porte ${PORT}`));
