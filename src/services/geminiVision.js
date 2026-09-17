import { GoogleGenAI } from "@google/genai";

// ---------------------------------------------------------------------------
// Schema — kept minimal: only items[] is required.
// notes is dropped to keep the output surface as small as possible and avoid
// the model refusing to parse lenient/informal images due to missing fields.
// ---------------------------------------------------------------------------
const PRESCRIPTION_PARSE_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      description: "List of medications visible in the image",
      items: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Medication name exactly as visible in the image",
          },
          quantity: {
            type: "number",
            description: "Numeric quantity (default 1 if not specified)",
          },
        },
        required: ["name", "quantity"],
      },
    },
  },
  required: ["items"],
};

// ---------------------------------------------------------------------------
// Lenient OCR prompt — accepts prescriptions, handwritten notes,
// pill bottle labels, screenshots, etc. No formal format required.
// ---------------------------------------------------------------------------
const PRESCRIPTION_PARSE_PROMPT = `You are a flexible medical OCR assistant. Analyze this image (which could be a doctor's prescription, handwritten note, pill bottle label, or screenshot). Extract ANY visible medication names, dosages, and quantities.

Do NOT require a formal doctor signature, clinic header, or specific layout. If medication text is visible, extract it.

Return ONLY a JSON object formatted as:
{ "items": [{ "name": "Medication Name", "quantity": 1 }] }

If absolutely no medications can be identified, return { "items": [] }.`;

// ---------------------------------------------------------------------------
// Utility: strip Markdown code fences Gemini sometimes wraps its output in
// e.g. ```json\n{...}\n``` or ```\n{...}\n```
// ---------------------------------------------------------------------------
function stripMarkdownCodeBlock(raw) {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

// ---------------------------------------------------------------------------
// Utility: attempt to extract the first valid JSON object from an arbitrary
// string, even if the model prefixes it with a sentence.
// ---------------------------------------------------------------------------
function extractJsonObject(raw) {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return raw.slice(start, end + 1);
}

/**
 * Parses an image using Gemini Vision and extracts any visible medication data.
 * Designed to be maximally lenient — works on prescriptions, bottle labels,
 * handwritten notes, and screenshots.
 *
 * @param {Buffer} imageBuffer - Raw image buffer from WhatsApp media download.
 * @param {string} mimeType    - MIME type of the image (e.g. "image/jpeg").
 * @returns {Promise<{ items: Array<{ name: string, quantity: number }> } | null>}
 *   Returns null only when Gemini fails entirely or finds zero medications.
 */
export async function parsePrescriptionImage(imageBuffer, mimeType = "image/jpeg") {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("[GEMINI VISION] GEMINI_API_KEY is not set");
    return null;
  }

  const base64Data = imageBuffer.toString("base64");
  console.log(
    `[GEMINI VISION] Sending image to Gemini. MIME: ${mimeType}, base64 length: ${base64Data.length}`
  );

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

    // -------------------------------------------------------------------------
    // Log the full raw string for debugging in Render logs
    // -------------------------------------------------------------------------
    const rawText = response.text;
    console.log("[GEMINI VISION] Raw Gemini response (full):", rawText);

    // -------------------------------------------------------------------------
    // Robust JSON parsing with two fallback layers:
    //   1. Strip Markdown code fences and parse
    //   2. Extract the first {...} block from the string
    // -------------------------------------------------------------------------
    let parsed = null;

    // Attempt 1: clean code fences → JSON.parse
    try {
      const cleaned = stripMarkdownCodeBlock(rawText);
      parsed = JSON.parse(cleaned);
      console.log("[GEMINI VISION] JSON parsed successfully (attempt 1 — stripped fences).");
    } catch (parseErr1) {
      console.warn("[GEMINI VISION] Attempt 1 parse failed:", parseErr1.message);

      // Attempt 2: extract the first {...} object and parse
      try {
        const extracted = extractJsonObject(rawText);
        if (!extracted) throw new Error("No JSON object found in response");
        parsed = JSON.parse(extracted);
        console.log("[GEMINI VISION] JSON parsed successfully (attempt 2 — extracted object).");
      } catch (parseErr2) {
        console.error("[GEMINI VISION] Both parse attempts failed. Raw response was:", rawText);
        console.error("[GEMINI VISION] Attempt 2 error:", parseErr2.message);
        return null;
      }
    }

    // -------------------------------------------------------------------------
    // Guard: empty items → inform caller to ask user for manual input
    // -------------------------------------------------------------------------
    if (!parsed.items || parsed.items.length === 0) {
      console.warn("[GEMINI VISION] Gemini returned an empty items array — no medications identified.");
      return null;
    }

    console.log(
      `[GEMINI VISION] ✅ Extracted ${parsed.items.length} medication(s):`,
      parsed.items.map((i) => `${i.name} (x${i.quantity})`).join(", ")
    );

    return parsed;
  } catch (err) {
    console.error("[GEMINI VISION] Unexpected error during Gemini Vision call:", err.message);
    return null;
  }
}
