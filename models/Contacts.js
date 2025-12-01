import mongoose from "mongoose";

const contactSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    phone: { type: String, required: true, unique: true },
    avatar: String,
    tags: [String],
    notes: String,
    lastMessageAt: { type: Date },
  },
  { timestamps: true }
);

export default mongoose.model("Contact", contactSchema);
