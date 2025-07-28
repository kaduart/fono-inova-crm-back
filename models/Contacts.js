// models/Contact.ts
import mongoose, { Schema } from 'mongoose';

const ContactSchema = new Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true, unique: true },
  avatar: { type: String },
});

export default mongoose.model('Contact', ContactSchema);
