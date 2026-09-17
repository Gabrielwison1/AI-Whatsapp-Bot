import axios from 'axios';

/**
 * Initializes a Paystack transaction and returns the authorization URL.
 * Paystack expects an email, so a placeholder is generated if none is provided.
 */
export async function initializePaystackTransaction(phone, orderId, amountInNaira) {
  try {
    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email: `customer-${orderId.toLowerCase()}@prosemedistore.com`, // Dummy email since WhatsApp uses phone
        amount: amountInNaira * 100, // Paystack requires amount in kobo/lowest denomination
        metadata: {
          customerPhone: phone,
          orderId: orderId,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    return response.data.data.authorization_url;
  } catch (error) {
    console.error('[PAYSTACK] Error initializing transaction:', error.response?.data || error.message);
    throw error;
  }
}
