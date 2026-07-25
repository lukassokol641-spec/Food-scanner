// ENDPOINT PRE SKENER LEKÁRSKYCH SPRÁV A KRVNÝCH TESTOV
app.post('/api/scan-medical', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nebol odoslaný žiadny obrázok.' });
    }

    const lang = req.body.lang || 'sk';
    const imageBase64 = req.file.buffer.toString('base64');

    const promptText = `
Analýzuj tento lekársky nález, lekársku správu alebo krvné testy.
Výstup vráť STRICTNE ako čistý JSON v jazyku: ${lang}.

Formát JSON odpovede:
{
  "summary": "Stručné a zrozumiteľné zhrnutie správy ľudskou rečou bez zložitej latinčiny (2-3 vety).",
  "diagnoses": ["Zoznam hlavných diagnóz alebo nálezov"],
  "blood_markers": [
    {
      "name": "Názov parametra (napr. Glukóza, Cholesterol)",
      "value": "Nameraná hodnota s jednotkou",
      "status": "normal" | "high" | "low",
      "note": "Krátke vysvetlenie, čo to znamená"
    }
  ],
  "dietary_recommendations": [
    "Konkrétne odporúčania pre stravu na základe nálezu"
  ],
  "suggested_profile": "general" | "heart" | "diabetes" | "clean",
  "suggested_allergens": ["gluten", "lactose", "nuts", "palmoil"]
}
`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: promptText },
            {
              type: "image_url",
              image_url: { url: `data:${req.file.mimetype};base64,${imageBase64}` }
            }
          ]
        }
      ],
      response_format: { type: "json_object" }
    });

    const result = JSON.parse(response.choices[0].message.content);
    res.json(result);

  } catch (error) {
    console.error('Chyba pri analýze lekárskej správy:', error);
    res.status(500).json({ error: 'Chyba pri spracovaní lekárskej správy.' });
  }
});
