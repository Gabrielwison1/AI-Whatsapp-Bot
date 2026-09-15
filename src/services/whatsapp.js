const META_API_VERSION = "v18.0";
const GRAPH_API_BASE = "https://graph.facebook.com";

function getPhoneNumberId() {
  return process.env.WHATSAPP_PHONE_NUMBER_ID;
}

function getAccessToken() {
  return process.env.WHATSAPP_ACCESS_TOKEN;
}

export async function sendWhatsAppMessage(to, text) {
  const phoneNumberId = getPhoneNumberId();
  const accessToken = getAccessToken();

  if (!phoneNumberId || !accessToken) {
    console.error(
      "[WHATSAPP] Missing WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN"
    );
    return null;
  }

  const url = `${GRAPH_API_BASE}/${META_API_VERSION}/${phoneNumberId}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { body: text },
  };

  console.log(`[WHATSAPP] Sending message to ${to}: "${text.substring(0, 80)}${text.length > 80 ? "..." : ""}"`);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`[WHATSAPP] Send failed (${response.status}): ${errorBody}`);
      return null;
    }

    const data = await response.json();
    console.log(`[WHATSAPP] Message sent successfully, message ID: ${data?.messages?.[0]?.id || "unknown"}`);
    return data;
  } catch (error) {
    console.error("[WHATSAPP] Send error:", error.message);
    return null;
  }
}

export async function downloadMetaMedia(mediaId) {
  const accessToken = getAccessToken();

  if (!accessToken) {
    console.error("[WHATSAPP] Missing WHATSAPP_ACCESS_TOKEN for media download");
    return null;
  }

  const mediaUrl = `${GRAPH_API_BASE}/${META_API_VERSION}/${mediaId}`;

  console.log(`[WHATSAPP] Fetching media URL for media ID: ${mediaId}`);

  try {
    const metaResponse = await fetch(mediaUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!metaResponse.ok) {
      const errorBody = await metaResponse.text();
      console.error(`[WHATSAPP] Media URL fetch failed (${metaResponse.status}): ${errorBody}`);
      return null;
    }

    const mediaInfo = await metaResponse.json();
    const downloadUrl = mediaInfo.url;
    const mimeType = mediaInfo.mime_type || "image/jpeg";

    console.log(`[WHATSAPP] Downloading media from ${downloadUrl.substring(0, 60)}...`);

    const imageResponse = await fetch(downloadUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!imageResponse.ok) {
      console.error(`[WHATSAPP] Image download failed (${imageResponse.status})`);
      return null;
    }

    const arrayBuffer = await imageResponse.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const base64Buffer = buffer.toString("base64");

    console.log(`[WHATSAPP] Media downloaded, base64 length: ${base64Buffer.length}, mime: ${mimeType}`);

    return { base64Buffer, mimeType };
  } catch (error) {
    console.error("[WHATSAPP] Media download error:", error.message);
    return null;
  }
}
