import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";

const TEXT_ORDER_SCHEMA = {
  type: "object",
  properties: {
    customerName: {
      type: "string",
      description: "Full name of the customer placing the order",
    },
    items: {
      type: "array",
      description: "List of medication items requested",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name of the medication" },
          quantity: { type: "string", description: "Quantity requested, e.g. '2 packs', '1 bottle'" },
        },
        required: ["name"],
      },
    },
    deliveryAddress: {
      type: "string",
      description: "Full delivery address provided by the customer",
    },
    state: {
      type: "string",
      description: "Nigerian state for geo-routing, e.g. 'FCT', 'Lagos', 'Rivers'",
    },
    requiresPrescription: {
      type: "boolean",
      description: "True if any of the requested items typically require a doctor's prescription",
    },
  },
  required: ["customerName", "items", "deliveryAddress", "state", "requiresPrescription"],
};

const PRESCRIPTION_SCHEMA = {
  type: "object",
  properties: {
    isValid: {
      type: "boolean",
      description: "True if the image appears to be a valid medical prescription",
    },
    medications: {
      type: "array",
      description: "List of medication names visible on the prescription",
      items: { type: "string" },
    },
  },
  required: ["isValid", "medications"],
};

function getProvider() {
  return (process.env.AI_PROVIDER || "gemini").toLowerCase();
}

function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  return new GoogleGenAI({ apiKey });
}

function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  return new OpenAI({ apiKey });
}

const TEXT_ORDER_PROMPT = `You are an order parser for a Nigerian telemedicine pharmacy service called ProseMedistore. Parse the customer's WhatsApp message into a structured order. Extract:
- customerName: the customer's full name
- items: array of { name, quantity } for each medication requested
- deliveryAddress: the delivery address
- state: the Nigerian state (normalize to full state name, e.g. "FCT" for Abuja, "Lagos", "Rivers")
- requiresPrescription: true if any item typically requires a doctor's prescription (e.g. antibiotics, controlled drugs, insulin)

If a field is not mentioned, use an empty string for strings, empty array for items, and false for requiresPrescription.`;

const PRESCRIPTION_PROMPT = `You are a prescription verification assistant for a Nigerian telemedicine pharmacy. Examine the provided image and determine:
- isValid: true if the image appears to be a legitimate medical prescription (has doctor details, patient name, medication list, signature/stamp)
- medications: list of medication names you can read from the prescription

If the image is not a prescription (e.g. a random photo), set isValid to false and medications to an empty array.`;

export async function extractOrderFromText(messageText) {
  const provider = getProvider();
  console.log(`[AI] extractOrderFromText via ${provider}, input length: ${messageText.length}`);

  try {
    if (provider === "openai") {
      return await extractOrderFromTextOpenAI(messageText);
    }
    return await extractOrderFromTextGemini(messageText);
  } catch (error) {
    console.error("[AI] extractOrderFromText error:", error.message);
    return null;
  }
}

async function extractOrderFromTextGemini(messageText) {
  const genAI = getGeminiClient();
  const response = await genAI.models.generateContent({
    model: "gemini-3.6-flash",
    contents: `${TEXT_ORDER_PROMPT}\n\nCustomer message: "${messageText}"`,
    config: {
      responseMimeType: "application/json",
      responseSchema: TEXT_ORDER_SCHEMA,
    },
  });

  const text = response.text;
  console.log("[AI] Gemini text order response:", text.substring(0, 200));
  return JSON.parse(text);
}

async function extractOrderFromTextOpenAI(messageText) {
  const client = getOpenAIClient();
  const response = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: TEXT_ORDER_PROMPT },
      { role: "user", content: messageText },
    ],
    response_format: { type: "json_schema", json_schema: { name: "order", schema: TEXT_ORDER_SCHEMA, strict: true } },
  });

  const text = response.choices[0].message.content;
  console.log("[AI] OpenAI text order response:", text.substring(0, 200));
  return JSON.parse(text);
}

export async function verifyPrescriptionImage(base64Buffer, mimeType = "image/jpeg") {
  const provider = getProvider();
  console.log(`[AI] verifyPrescriptionImage via ${provider}, base64 length: ${base64Buffer.length}`);

  try {
    if (provider === "openai") {
      return await verifyPrescriptionImageOpenAI(base64Buffer, mimeType);
    }
    return await verifyPrescriptionImageGemini(base64Buffer, mimeType);
  } catch (error) {
    console.error("[AI] verifyPrescriptionImage error:", error.message);
    return null;
  }
}

async function verifyPrescriptionImageGemini(base64Buffer, mimeType) {
  const genAI = getGeminiClient();
  const response = await genAI.models.generateContent({
    model: "gemini-3.6-flash",
    contents: [
      {
        inlineData: {
          mimeType,
          data: base64Buffer,
        },
      },
      { text: PRESCRIPTION_PROMPT },
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: PRESCRIPTION_SCHEMA,
    },
  });

  const text = response.text;
  console.log("[AI] Gemini prescription response:", text.substring(0, 200));
  return JSON.parse(text);
}

async function verifyPrescriptionImageOpenAI(base64Buffer, mimeType) {
  const client = getOpenAIClient();
  const dataUrl = `data:${mimeType};base64,${base64Buffer}`;

  const response = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: PRESCRIPTION_PROMPT },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    response_format: { type: "json_schema", json_schema: { name: "prescription", schema: PRESCRIPTION_SCHEMA, strict: true } },
  });

  const text = response.choices[0].message.content;
  console.log("[AI] OpenAI prescription response:", text.substring(0, 200));
  return JSON.parse(text);
}
