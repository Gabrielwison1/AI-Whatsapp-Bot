const SESSION_STATES = {
  IDLE: "IDLE",
  AWAITING_PRESCRIPTION: "AWAITING_PRESCRIPTION",
  GEO_ROUTING: "GEO_ROUTING",
  AWAITING_PAYMENT: "AWAITING_PAYMENT",
};

const sessions = new Map();

let orderCounter = 1041;

export function generateOrderId() {
  orderCounter += 1;
  return `ORD-${orderCounter}`;
}

export function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, {
      phone,
      state: SESSION_STATES.IDLE,
      orderData: null,
      orderId: null,
      matchedPharmacy: null,
      prescriptionVerified: false,
      updatedAt: Date.now(),
    });
  }
  return sessions.get(phone);
}

export function updateSession(phone, updates) {
  const session = getSession(phone);
  Object.assign(session, updates, { updatedAt: Date.now() });
  console.log(`[SESSION] ${phone} → state: ${session.state}, orderId: ${session.orderId || "none"}`);
  return session;
}

export function resetSession(phone) {
  sessions.set(phone, {
    phone,
    state: SESSION_STATES.IDLE,
    orderData: null,
    orderId: null,
    matchedPharmacy: null,
    prescriptionVerified: false,
    updatedAt: Date.now(),
  });
  console.log(`[SESSION] ${phone} → reset to IDLE`);
}

export function getAllSessions() {
  return Array.from(sessions.values());
}

export { SESSION_STATES };
