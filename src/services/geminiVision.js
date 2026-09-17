import { GoogleGenAI } from "@google/genai";

const PRESCRIPTION_PARSE_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      description: "List of medications extracted from the prescription",
      items: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Name of the medication exactly as written on the prescription",
          },
          quantity: {
            type: "number",
            description: "Numeric quantity prescribed (e.g. 1 for '1 pack', 2 for '2 tablets'). Default to 1 if not specified.",
          },
        },
        required: ["name", "quantity"],
      },
    },
    notes: {
      type: "string",
      description: "Any special usage instructions or dosage notes visible on the prescription. Empty string if none.",
    },
  },
  required: ["items", "notes"],
};

const PRESCRIPTION_PARSE_PROMPT = `You are a medical prescription parser for a Nigerian telemedicine pharmacy.
Examine the provided prescription image and extract ALL prescribed medications.
Return ONLY a JSON object with this exact structure:
{
  "items": [{ "name": "Medication Name", "quantity": 1 }],
  "notes": "any special usage instructions if visible"
}
Rules:
- Include every distinct medication listed on the prescription.
- Use the medication name exactly as written (brand or generic).
- Set quantity to the numeric value (e.g. 30 for "30 tablets", 1 if unspecified).
- If the image is unreadable or is not a prescription, return { "items": [], "notes": "" }.`;

/**
 * Parses a prescription image using Gemini Vision and returns structured medication data.
 * @param {Buffer} imageBuffer - Raw image buffer from WhatsApp media download.
 * @param {string} mimeType - MIME type of the image (e.g. "image/jpeg").
 * @returns {Promise<{ items: Array<{ name: string, quantity: number }>, notes: string } | null>}
 */
export async function parsePrescriptionImage(imageBuffer, mimeType = "image/jpeg") {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("[GEMINI VISION] GEMINI_API_KEY is not set");
    return null;
  }

  const base64Data = imageBuffer.toString("base64");
  console.log(`[GEMINI VISION] Parsing prescription image. MIME: ${mimeType}, base64 length: ${base64Data.length}`);

  try {
    const genAI = new GoogleGenAI({ apiKey });

    const response = await genAI.models.generateContent({
      model: "gemini-3.6-flash",
      contents: [
        {
          inlineData: {
            mimeType,
            data: base64Data,
          },
        },
        { text: PRESCRIPTION_PARSE_PROMPT },
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: PRESCRIPTION_PARSE_SCHEMA,
      },
    });

    const text = response.text;
    console.log("[GEMINI VISION] Raw prescription parse response:", text.substring(0, 300));

    const parsed = JSON.parse(text);

    // Guard: treat empty items array as a parse failure
    if (!parsed.items || parsed.items.length === 0) {
      console.warn("[GEMINI VISION] Prescription parsed but no medications found.");
      return null;
    }

    console.log(`[GEMINI VISION] Extracted ${parsed.items.length} medication(s):`, parsed.items.map((i) => i.name).join(", "));
    return parsed;
  } catch (err) {
    console.error("[GEMINI VISION] Failed to parse prescription image:", err.message);
    return null;
  }
}
