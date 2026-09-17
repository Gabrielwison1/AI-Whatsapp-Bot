import mongoose from 'mongoose';

const sessionSchema = new mongoose.Schema({
  phone: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  currentState: {
    type: String,
    default: 'IDLE',
  },
  activeOrderId: {
    type: String,
  },
  orderData: {
    type: mongoose.Schema.Types.Mixed,
  },
  prescriptionVerified: {
    type: Boolean,
    default: false,
  },
  matchedPharmacy: {
    type: mongoose.Schema.Types.Mixed,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

export const Session = mongoose.model('Session', sessionSchema);
