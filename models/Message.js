import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema({
    from: String,
    to: String,
    direction: { type: String, enum: ['inbound', 'outbound'], required: true },
    type: { type: String, enum: ['text', 'template', 'image', 'audio'], default: 'text' },
    content: String,
    templateName: String,
    status: { type: String, enum: ['sent', 'delivered', 'read', 'failed', 'received'], default: 'sent' },
    timestamp: { type: Date, default: Date.now },
    lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' }
}, { timestamps: true });

messageSchema.index({ to: 1, from: 1, timestamp: -1 });

export default mongoose.model('Message', messageSchema);
