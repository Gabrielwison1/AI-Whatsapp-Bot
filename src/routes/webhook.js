import { Router } from "express";
import { sendWhatsAppMessage, downloadMetaMedia } from "../services/whatsapp.js";
import { extractOrderFromText, verifyPrescriptionImage } from "../services/ai.js";
import { findPharmacyByState } from "../db/pharmacies.js";
import {
  getSession,
  updateSession,
  resetSession,
  generateOrderId,
  SESSION_STATES,
} from "../state/sessionStore.js";

const webhookRouter = Router();

webhookRouter.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token && mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log("[WEBHOOK] Verification successful");
    return res.status(200).send(challenge);
  }

  console.warn("[WEBHOOK] Verification failed", { mode, token });
  return res.sendStatus(403);
});

webhookRouter.post("/", (req, res) => {
  res.status(200).send("OK");
  processWebhook(req.body).catch((err) => {
    console.error("[WEBHOOK] Async processing error:", err);
  });
});

async function processWebhook(body) {
  const message =
    body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  const from = message?.from;

  if (!from || !message) {
    console.log("[WEBHOOK] No message in payload, ignoring");
    return;
  }

  const session = getSession(from);
  console.log(`[WEBHOOK] Message from ${from}, current state: ${session.state}`);

  try {
    if (message.type === "text" && message.text?.body) {
      await handleTextMessage(from, message.text.body, session);
    } else if (message.type === "image" && message.image) {
      await handleImageMessage(from, message.image, session);
    } else {
      console.log(`[WEBHOOK] Unsupported message type: ${message.type}`);
      await sendWhatsAppMessage(
        from,
        "Sorry, I can only process text messages and prescription photos. Please send your order as text."
      );
    }
  } catch (error) {
    console.error(`[WEBHOOK] Error processing message from ${from}:`, error);
    await sendWhatsAppMessage(
      from,
      "Something went wrong processing your message. Please try again."
    );
  }
}

async function handleTextMessage(from, text, session) {
  if (session.state === SESSION_STATES.AWAITING_PRESCRIPTION) {
    await sendWhatsAppMessage(
      from,
      "I'm waiting for a prescription photo. Please upload a clear image of your prescription."
    );
    return;
  }

  if (session.state === SESSION_STATES.AWAITING_PAYMENT) {
    await sendWhatsAppMessage(
      from,
      "Your order is already being processed. Please complete payment using the link sent earlier, or type 'new order' to start again."
    );
    if (text.toLowerCase().includes("new order")) {
      resetSession(from);
      await sendWhatsAppMessage(from, "Session reset. Please send your new order.");
    }
    return;
  }

  await processNewOrder(from, text);
}

async function processNewOrder(from, text) {
  console.log(`[STATE 1] Parsing order from ${from}`);
  const orderData = await extractOrderFromText(text);

  if (!orderData) {
    await sendWhatsAppMessage(
      from,
      "I couldn't understand your order. Please send your order with your name, medications, delivery address, and state."
    );
    return;
  }

  const orderId = generateOrderId();
  updateSession(from, { state: SESSION_STATES.IDLE, orderData, orderId });

  console.log(`[AI] Parsed order for ${from}:`, JSON.stringify(orderData));

  if (orderData.requiresPrescription) {
    console.log(`[STATE 1] Order ${orderId} requires prescription → AWAITING_PRESCRIPTION`);
    updateSession(from, { state: SESSION_STATES.AWAITING_PRESCRIPTION });
    await sendWhatsAppMessage(
      from,
      `Hello ${orderData.customerName || ""}, thanks for your order (#${orderId}). Some of your medications require a prescription. Please upload a clear photo of your prescription now.`
    );
    return;
  }

  await routeToPharmacy(from, orderData, orderId);
}

async function handleImageMessage(from, image, session) {
  if (session.state !== SESSION_STATES.AWAITING_PRESCRIPTION) {
    await sendWhatsAppMessage(
      from,
      "I wasn't expecting a photo. Please send your order as a text message first."
    );
    return;
  }

  const mediaId = image.id;
  console.log(`[STATE 2] Received prescription image from ${from}, media ID: ${mediaId}`);

  const media = await downloadMetaMedia(mediaId);
  if (!media) {
    await sendWhatsAppMessage(from, "I couldn't download your image. Please try uploading it again.");
    return;
  }

  const result = await verifyPrescriptionImage(media.base64Buffer, media.mimeType);
  if (!result) {
    await sendWhatsAppMessage(from, "I couldn't analyze your prescription. Please try uploading a clearer photo.");
    return;
  }

  console.log(`[AI] Prescription verification for ${from}:`, JSON.stringify(result));

  if (!result.isValid) {
    console.log(`[STATE 2] Invalid prescription from ${from}, asking re-upload`);
    await sendWhatsAppMessage(
      from,
      "The image doesn't appear to be a valid medical prescription. Please upload a clear photo of your prescription showing the doctor's details, medications, and signature."
    );
    return;
  }

  console.log(`[STATE 2] Prescription valid for ${from}, medications: ${result.medications.join(", ")}`);
  updateSession(from, { prescriptionVerified: true });

  const orderData = session.orderData || {};
  if (result.medications && result.medications.length > 0) {
    const existingNames = new Set((orderData.items || []).map((i) => i.name.toLowerCase()));
    for (const med of result.medications) {
      if (!existingNames.has(med.toLowerCase())) {
        orderData.items = orderData.items || [];
        orderData.items.push({ name: med, quantity: "as prescribed" });
      }
    }
    updateSession(from, { orderData });
  }

  await routeToPharmacy(from, orderData, session.orderId);
}

async function routeToPharmacy(from, orderData, orderId) {
  const state = orderData.state;
  console.log(`[STATE 3] Geo-routing order ${orderId} for state: ${state}`);

  const pharmacy = findPharmacyByState(state);

  if (!pharmacy) {
    console.log(`[STATE 3] No partner pharmacy found for state: ${state}`);
    updateSession(from, { state: SESSION_STATES.IDLE });
    await sendWhatsAppMessage(
      from,
      `Sorry, we don't currently have a partner pharmacy in ${state || "your area"}. We're expanding quickly — please check back soon. Your order (#${orderId}) has been cancelled.`
    );
    resetSession(from);
    return;
  }

  console.log(`[STATE 3] Matched pharmacy: ${pharmacy.name} (${pharmacy.city}, ${pharmacy.state})`);
  console.log(`[PHARMACY PING] Order #${orderId} available for fulfillment at ${pharmacy.name}. Broadcasting to ${pharmacy.phone}...`);

  updateSession(from, {
    state: SESSION_STATES.AWAITING_PAYMENT,
    matchedPharmacy: pharmacy,
  });

  await sendPaymentSummary(from, orderData, orderId, pharmacy);
}

async function sendPaymentSummary(from, orderData, orderId, pharmacy) {
  const items = (orderData.items || []).map((i) => `• ${i.name}${i.quantity ? ` (${i.quantity})` : ""}`).join("\n");
  const paystackUrl = `https://paystack.com/pay/mock-prosemedistore-${orderId.toLowerCase()}`;

  console.log(`[STATE 4] Generating payment link for ${from}: ${paystackUrl}`);

  const summary = `✅ Order Confirmed (#${orderId})

Hi ${orderData.customerName || "Customer"}, here's your order summary:

${items}

Delivery Address: ${orderData.deliveryAddress || "Not specified"}
State: ${orderData.state || "Not specified"}

Matched Pharmacy: ${pharmacy.name} (${pharmacy.city}, ${pharmacy.state})

💳 Payment Link: ${paystackUrl}

Please complete payment to confirm your order. Once payment is received, ${pharmacy.name} will begin fulfillment.`;

  await sendWhatsAppMessage(from, summary);

  console.log(`[STATE 4] Order ${orderId} complete for ${from}, resetting session`);
  resetSession(from);
}

export default webhookRouter;
