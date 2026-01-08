import mongoose from "mongoose";

const contactSchema = new mongoose.Schema(
  {
    name: { type: String, default: 'WhatsApp' },
    phone: { type: String, required: true, unique: true },
    avatar: String,
    tags: [String],
    notes: String,
    lastMessageAt: { type: Date },
    lastMessagePreview: { type: String },
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: "Leads", default: null },
  },
  { timestamps: true }
);

export default mongoose.model("Contact", contactSchema);
