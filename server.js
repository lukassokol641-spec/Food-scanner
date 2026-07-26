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

app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

const reviewsDb = {};
const cloudBackupDb = {};
const supportTicketsDb = [];
let totalRegisteredUsers = 1248;
const activeSessions = new Map();

const marketplaceDb = [
  {
    id: "item_1",
    title: "Čerstvé domáce vajíčka z voľného chovu",
    category: "Vajíčka",
    price: "2.50 € / 10ks",
    city: "Revúca",
    description: "Čerstvé vajíčka od sliepok kŕmených čistým obilím a trávou.",
    contact: "0901 234 567",
    created_at: new Date().toISOString()
  },
  {
    id: "item_2",
    title: "Poctivý lesný med z vlastnej včelnice",
    category: "Med & Džemy",
    price: "8.00 € / 1kg",
    city: "Revúca",
    description: "Kvalitný májový med priamo od včelára bez pridaného cukru.",
    contact: "vcelar.revuca@gmail.com",
    created_at: new Date().toISOString()
  }
];

app.post('/api/heartbeat', (req, res) => {
  const { sessionId } = req.body;
  if (sessionId) {
    activeSessions.set(sessionId, Date.now());
  }

  const now = Date.now();
  for (const [id, lastPing] of activeSessions.entries()) {
    if (now - lastPing > 30000) {
      activeSessions.delete(id);
    }
  }

  res.json({
    online: Math.max(1, activeSessions.size),
    totalRegistered: totalRegisteredUsers
  });
});

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
  "origin_info": {
    "country": "Krajina pôvodu (napr. Slovensko, Španielsko, Čile)",
    "distance_km": "~150 km",
    "eco_level": "local" | "regional" | "distant",
    "eco_label": "🌿 Lokálny produkt / 🚚 Stredná trasa / ✈️ Dlhý dovoz",
    "eco_note": "Krátke vysvetlenie uhlíkovej stopy prepravy k zákazníkovi na stôl"
  },
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

app.post('/api/discounts', async (req, res) => {
  try {
    const { city, stores, shoppingList, lang } = req.body;
    if (!city || !stores || stores.length === 0 || !shoppingList || shoppingList.length === 0) {
      return res.status(400).json({ error: 'Chýbajú parametre pre kontrolu letákov.' });
    }

    const promptText = `
Si nákupný asistent pre akčné ponuky na Slovensku. Mesto: ${city}. Predajne: ${stores.join(', ')}. Nákupný zoznam: ${JSON.stringify(shoppingList)}.
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

app.post('/api/daily-menu', async (req, res) => {
  try {
    const { city, profile, allergens, currentTime, medicalNotes, lang } = req.body;
    const userCity = city || "Revúca";

    const promptText = `
Si gastro asistent pre denné menu a reštaurácie na Slovensku. Mesto: ${userCity}. Čas: ${currentTime}.
Vráť STRICTNE čistý JSON:
{
  "mode": "lunch_menu" | "regular_menu",
  "city": "${userCity}",
  "time_info": "Text informujúci o režime",
  "restaurants": [
    {
      "name": "Názov reštaurácie",
      "address": "Ulica",
      "serving_hours": "11:00 - 13:30",
      "menu_items": [
        { "title": "Názov jedla", "price": "6.50 €", "is_suitable": true | false, "warning": "Dôvod ak nie je vhodné", "health_score": "Skóre" }
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
    res.status(500).json({ error: 'Chyba pri vyhľadávaní reštaurácií.' });
  }
});

app.post('/api/assistant-summary', async (req, res) => {
  try {
    const { city, lang } = req.body;
    const userCity = city || "Revúca";

    const promptText = `
Si inteligentný osobné asistent na Slovensku. Mesto: ${userCity}.
Vráť STRICTNE čistý JSON v jazyku ${lang || 'sk'}:
{
  "holiday_alert": "Varovanie pred sviatkom a otváracími hodinami (napr. Billa do 19:00, Tesco do 22:00)",
  "daily_tip": "Pripomienka pitného režimu a zdravého dňa",
  "nameday_today": "Kto má dnes meniny na Slovensku"
}
`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: promptText }],
      response_format: { type: "json_object" }
    });

    res.json(JSON.parse(response.choices[0].message.content));
  } catch (error) {
    res.status(500).json({ error: 'Chyba pri generovaní súhrnu.' });
  }
});

app.get('/api/marketplace', (req, res) => {
  const city = (req.query.city || "Revúca").toLowerCase();
  const filtered = marketplaceDb.filter(item => item.city.toLowerCase().includes(city) || city.includes(item.city.toLowerCase()));
  res.json(filtered.length > 0 ? filtered : marketplaceDb);
});

app.post('/api/marketplace', (req, res) => {
  const { title, category, price, city, description, contact } = req.body;
  if (!title || !price || !contact) return res.status(400).json({ error: 'Chýbajú povinné údaje.' });

  const newItem = {
    id: "item_" + Date.now(),
    title,
    category: category || "Všeobecné",
    price,
    city: city || "Revúca",
    description: description || "Domáci produkt od člena komunity.",
    contact,
    created_at: new Date().toISOString()
  };

  marketplaceDb.unshift(newItem);
  res.json({ ok: true, item: newItem });
});

app.post('/api/support', (req, res) => {
  const { message, deviceInfo, userContact } = req.body;
  if (!message) return res.status(400).json({ error: 'Správa nemôže byť prázdna.' });

  const ticket = {
    id: "ticket_" + Date.now(),
    message,
    deviceInfo: deviceInfo || "Neznáme zariadenie",
    userContact: userContact || "Anonym",
    created_at: new Date().toISOString()
  };

  supportTicketsDb.unshift(ticket);
  res.json({ ok: true, message: 'Hlásenie bolo úspešne odoslané podpore. Ďakujeme!' });
});

app.post('/api/cloud/save', (req, res) => {
  const { syncKey, data } = req.body;
  if (!syncKey || !data) return res.status(400).json({ error: 'Chýba kľúč alebo dáta.' });
  cloudBackupDb[syncKey] = { updated_at: new Date().toISOString(), content: data };
  res.json({ ok: true, message: 'Záloha bola úspešne uložená na cloud server.' });
});

app.get('/api/cloud/load', (req, res) => {
  const syncKey = req.query.syncKey;
  if (!syncKey || !cloudBackupDb[syncKey]) return res.status(404).json({ error: 'Záloha nebola nájdená.' });
  res.json({ ok: true, data: cloudBackupDb[syncKey].content });
});

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
