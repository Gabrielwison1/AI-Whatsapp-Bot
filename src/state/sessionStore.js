import { Session } from "../models/Session.js";

const SESSION_STATES = {
  IDLE: "IDLE",
  AWAITING_PRESCRIPTION: "AWAITING_PRESCRIPTION",
  GEO_ROUTING: "GEO_ROUTING",
  AWAITING_PAYMENT: "AWAITING_PAYMENT",
};

export function generateOrderId() {
  const timestamp = Date.now().toString().slice(-6);
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `ORD-${timestamp}${random}`;
}

export async function getSession(phone) {
  let session = await Session.findOne({ phone });
  
  if (!session) {
    session = await Session.create({
      phone,
      currentState: SESSION_STATES.IDLE,
    });
  }
  
  // Map back to the expected plain object for compatibility
  return {
    phone: session.phone,
    state: session.currentState,
    activeOrderId: session.activeOrderId,
    orderId: session.activeOrderId, // compatibility alias
    orderData: session.orderData,
    prescriptionVerified: session.prescriptionVerified,
    matchedPharmacy: session.matchedPharmacy,
    updatedAt: session.updatedAt,
  };
}

export async function updateSession(phone, updates) {
  const mappedUpdates = { ...updates };
  
  if (updates.state) {
    mappedUpdates.currentState = updates.state;
    delete mappedUpdates.state;
  }
  if (updates.orderId) {
    mappedUpdates.activeOrderId = updates.orderId;
    delete mappedUpdates.orderId;
  }
  
  mappedUpdates.updatedAt = Date.now();
  
  const session = await Session.findOneAndUpdate(
    { phone },
    { $set: mappedUpdates },
    { new: true, upsert: true }
  );
  console.log(`[SESSION] ${phone} → state: ${session.currentState}, orderId: ${session.activeOrderId || "none"}`);
  
  return {
    phone: session.phone,
    state: session.currentState,
    orderId: session.activeOrderId,
    orderData: session.orderData,
    prescriptionVerified: session.prescriptionVerified,
    matchedPharmacy: session.matchedPharmacy,
    updatedAt: session.updatedAt,
  };
}

export async function resetSession(phone) {
  const session = await Session.findOneAndUpdate(
    { phone },
    { 
      $set: {
        currentState: SESSION_STATES.IDLE,
        activeOrderId: null,
        orderData: null,
        matchedPharmacy: null,
        prescriptionVerified: false,
        updatedAt: Date.now() 
      }
    },
    { new: true }
  );
  console.log(`[SESSION] ${phone} → reset to IDLE`);
}

export { SESSION_STATES };
