import mongoose from 'mongoose';

const orderSchema = new mongoose.Schema({
  orderId: {
    type: String,
    required: true,
    unique: true,
  },
  customerPhone: {
    type: String,
    required: true,
  },
  customerName: {
    type: String,
  },
  items: [
    {
      name: String,
      quantity: String, // String instead of Number because users might say "as prescribed"
    }
  ],
  deliveryAddress: {
    type: String,
  },
  state: {
    type: String,
  },
  matchedPharmacy: {
    type: String,
  },
  totalAmount: {
    type: Number,
  },
  status: {
    type: String,
    enum: ['PENDING_PAYMENT', 'PAID', 'FULFILLED'],
    default: 'PENDING_PAYMENT',
  },
  paystackReference: {
    type: String,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

export const Order = mongoose.model('Order', orderSchema);
