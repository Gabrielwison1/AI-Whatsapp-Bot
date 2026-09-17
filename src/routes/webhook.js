import { Router } from "express";
import crypto from "crypto";
import { sendWhatsAppMessage, downloadMetaMedia } from "../services/whatsapp.js";
import { initializePaystackTransaction } from "../services/paystack.js";
import { extractOrderFromText, verifyPrescriptionImage } from "../services/ai.js";
import { parsePrescriptionImage } from "../services/geminiVision.js";
import { findPharmacyByState } from "../db/pharmacies.js";
import { Order } from "../models/Order.js";
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

  const session = await getSession(from);
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
    
    // Ensure session is reset so user is not permanently stuck
    await resetSession(from);

    const errorMessage = error.isBusyError
      ? error.message
      : "Something went wrong processing your message. Please try again.";

    await sendWhatsAppMessage(from, errorMessage);
  }
}

async function handleTextMessage(from, text, session) {
  if (session.state === SESSION_STATES.AWAITING_PRESCRIPTION) {
    console.log(`[STATE 1] User in AWAITING_PRESCRIPTION sent text instead of photo. Routing to text parser.`);
    // Fall through to processNewOrder
  } else if (session.state === SESSION_STATES.AWAITING_PAYMENT) {
    await sendWhatsAppMessage(
      from,
      "Your order is already being processed. Please complete payment using the link sent earlier, or type 'new order' to start again."
    );
    if (text.toLowerCase().includes("new order")) {
      await resetSession(from);
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
  await updateSession(from, { state: SESSION_STATES.IDLE, orderData, orderId });

  console.log(`[AI] Parsed order for ${from}:`, JSON.stringify(orderData));

  if (orderData.requiresPrescription) {
    console.log(`[STATE 1] Order ${orderId} requires prescription → AWAITING_PRESCRIPTION`);
    await updateSession(from, { state: SESSION_STATES.AWAITING_PRESCRIPTION });
    await sendWhatsAppMessage(
      from,
      `Hello ${orderData.customerName || ""}, thanks for your order (#${orderId}). Some of your medications require a prescription. Please upload a clear photo of your prescription now.`
    );
    return;
  }

  await routeToPharmacy(from, orderData, orderId);
}

async function handleImageMessage(from, image, session) {
  const mediaId = image.id;
  console.log(`[STATE 2] Received image from ${from}, media ID: ${mediaId}, session state: ${session.state}`);

  // Immediately acknowledge receipt so the user knows we're working on it
  await sendWhatsAppMessage(from, "📷 Prescription received! Analyzing the image...");

  // --- Step 1: Download the image binary from Meta's Graph API ---
  const media = await downloadMetaMedia(mediaId);
  if (!media) {
    await sendWhatsAppMessage(
      from,
      "I couldn't download your prescription image. Please try sending it again, or type your medication names manually."
    );
    return;
  }

  // Convert base64 string from downloadMetaMedia back to a Buffer for geminiVision
  const imageBuffer = Buffer.from(media.base64Buffer, "base64");

  // --- Step 2: Parse the prescription via Gemini Vision ---
  const parsed = await parsePrescriptionImage(imageBuffer, media.mimeType);
  if (!parsed || parsed.items.length === 0) {
    await sendWhatsAppMessage(
      from,
      "I couldn't read the medications from your prescription. Please send a clearer photo, or type your medication names and quantities directly."
    );
    return;
  }

  console.log(`[GEMINI VISION] Parsed ${parsed.items.length} item(s) from prescription for ${from}`);

  // --- Step 3A: AWAITING_PRESCRIPTION — merge into an existing pending order ---
  if (session.state === SESSION_STATES.AWAITING_PRESCRIPTION) {
    console.log(`[STATE 2] Merging prescription items into existing order for ${from}`);

    // Also run the legacy validity check so we reject obviously non-prescription images
    const verifyResult = await verifyPrescriptionImage(media.base64Buffer, media.mimeType);
    if (!verifyResult || !verifyResult.isValid) {
      console.log(`[STATE 2] Image failed validity check for ${from}`);
      await sendWhatsAppMessage(
        from,
        "The image doesn't appear to be a valid medical prescription. Please upload a clear photo showing the doctor's details, medications, and signature."
      );
      return;
    }

    await updateSession(from, { prescriptionVerified: true });

    const orderData = session.orderData || {};
    const existingNames = new Set((orderData.items || []).map((i) => i.name.toLowerCase()));

    for (const item of parsed.items) {
      if (!existingNames.has(item.name.toLowerCase())) {
        orderData.items = orderData.items || [];
        orderData.items.push({ name: item.name, quantity: String(item.quantity) });
      }
    }

    if (parsed.notes) {
      orderData.prescriptionNotes = parsed.notes;
    }

    await updateSession(from, { orderData });
    console.log(`[STATE 2] Updated order items for ${from}:`, JSON.stringify(orderData.items));

    await routeToPharmacy(from, orderData, session.orderId);
    return;
  }

  // --- Step 3B: Direct image (no prior text order) — build order from prescription ---
  console.log(`[STATE 2] Direct prescription image from ${from} with no pending order. Building order from parsed data.`);

  // We don't have the customer's delivery info yet — ask for it first
  const orderId = generateOrderId();
  const partialOrderData = {
    items: parsed.items.map((i) => ({ name: i.name, quantity: String(i.quantity) })),
    prescriptionNotes: parsed.notes || "",
    requiresPrescription: true,
  };

  await updateSession(from, {
    state: SESSION_STATES.AWAITING_PRESCRIPTION,
    orderData: partialOrderData,
    orderId,
  });

  const itemList = parsed.items.map((i) => `• ${i.name} (x${i.quantity})`).join("\n");
  await sendWhatsAppMessage(
    from,
    `✅ I've read your prescription! Here are the medications I found:\n\n${itemList}\n\n` +
    `To complete your order, please reply with your full name, delivery address, and state.\n` +
    `Example: _John Doe, 12 Broad Street Lagos Island, Lagos_`
  );
}

async function routeToPharmacy(from, orderData, orderId) {
  const state = orderData.state;
  console.log(`[STATE 3] Geo-routing order ${orderId} for state: ${state}`);

  const pharmacy = findPharmacyByState(state);

  if (!pharmacy) {
    console.log(`[STATE 3] No partner pharmacy found for state: ${state}`);
    await updateSession(from, { state: SESSION_STATES.IDLE });
    await sendWhatsAppMessage(
      from,
      `Sorry, we don't currently have a partner pharmacy in ${state || "your area"}. We're expanding quickly — please check back soon. Your order (#${orderId}) has been cancelled.`
    );
    await resetSession(from);
    return;
  }

  console.log(`[STATE 3] Matched pharmacy: ${pharmacy.name} (${pharmacy.city}, ${pharmacy.state})`);
  console.log(`[PHARMACY PING] Order #${orderId} available for fulfillment at ${pharmacy.name}. Broadcasting to ${pharmacy.phone}...`);

  await updateSession(from, {
    state: SESSION_STATES.AWAITING_PAYMENT,
    matchedPharmacy: pharmacy,
  });

  await sendPaymentSummary(from, orderData, orderId, pharmacy);
}

async function sendPaymentSummary(from, orderData, orderId, pharmacy) {
  const items = (orderData.items || []).map((i) => `• ${i.name}${i.quantity ? ` (${i.quantity})` : ""}`).join("\n");

  // Declared outside try blocks so it's accessible to both Paystack init and Order.create
  // In production, replace with a real price calculation based on orderData.items
  const totalAmountNaira = 5000;

  let paystackUrl = `https://paystack.com/pay/mock-prosemedistore-${orderId.toLowerCase()}`;

  try {
    paystackUrl = await initializePaystackTransaction(from, orderId, totalAmountNaira);
    console.log(`[STATE 4] Generated real Paystack payment link for ${from}: ${paystackUrl}`);
  } catch (err) {
    console.error(`[STATE 4] Paystack initialization failed for ${from}, falling back to mock URL. Reason:`, err.message);
  }

  // Persist the Order to MongoDB with status PENDING_PAYMENT before sending the link
  try {
    const newOrder = await Order.create({
      orderId,
      customerPhone: from,
      customerName: orderData.customerName,
      items: orderData.items,
      deliveryAddress: orderData.deliveryAddress,
      state: orderData.state,
      matchedPharmacy: pharmacy.name,
      totalAmount: totalAmountNaira,
      status: 'PENDING_PAYMENT',
    });
    console.log('[DB SUCCESS] Created order:', newOrder._id);
  } catch (err) {
    console.error(`[DB ERROR] Failed to save order ${orderId} for ${from}. Mongoose error:`, err.message, err.errors);
  }

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
  await resetSession(from);
}

// --- Paystack Webhook Handler ---
webhookRouter.post("/paystack", async (req, res) => {
  // Always return 200 OK immediately as per Paystack's requirements
  res.sendStatus(200);

  try {
    // Validate Signature
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret) {
      console.error("[PAYSTACK WEBHOOK] Missing PAYSTACK_SECRET_KEY in environment");
      return;
    }

    // req.body is already parsed as JSON by express.json() in server.js
    // Paystack signature check requires hashing the raw body. 
    // JSON.stringify works in most standard express setups, but consider using raw body parsing if signature validation fails.
    const hash = crypto.createHmac('sha512', secret).update(JSON.stringify(req.body)).digest('hex');
    
    if (hash !== req.headers['x-paystack-signature']) {
      console.error("[PAYSTACK WEBHOOK] Invalid signature");
      return;
    }

    const event = req.body;
    
    if (event.event === 'charge.success') {
      const { customerPhone, orderId } = event.data.metadata || {};
      
      if (customerPhone && orderId) {
        console.log(`[PAYSTACK WEBHOOK] Payment successful for order ${orderId} (Phone: ${customerPhone})`);
        
        // Update existing order status in MongoDB — never insert a new record
        try {
          const updatedOrder = await Order.findOneAndUpdate(
            { orderId },
            { $set: { status: 'PAID', paystackReference: event.data.reference } },
            { new: true }
          );
          if (updatedOrder) {
            console.log(`[DB SUCCESS] Order ${orderId} marked as PAID. Doc ID: ${updatedOrder._id}`);
          } else {
            console.warn(`[DB WARN] No order found with orderId: ${orderId} to mark as PAID.`);
          }
        } catch (err) {
          console.error(`[DB ERROR] Failed to update order ${orderId} to PAID. Mongoose error:`, err.message);
        }

        const receiptMessage = `🎉 Payment Successful!\n\nWe have received your payment for order #${orderId}. The pharmacy will now begin processing your fulfillment.`;
        await sendWhatsAppMessage(customerPhone, receiptMessage);
      } else {
        console.warn("[PAYSTACK WEBHOOK] charge.success received but missing customerPhone or orderId in metadata.");
      }
    }
  } catch (error) {
    console.error("[PAYSTACK WEBHOOK] Error processing webhook:", error);
  }
});

export default webhookRouter;
