// models/ChatContext.js
import mongoose from "mongoose";
const { Schema } = mongoose;

const ChatContextSchema = new Schema({
    lead: { type: Schema.Types.ObjectId, ref: "Leads", unique: true },
    lastSummary: { type: String, default: "" },
    lastUpdatedAt: { type: Date, default: Date.now },
    // 🆕 Armazena info extraída pelo último handler (awaitingComplaint, lastQuestion, etc)
    lastExtractedInfo: {
        type: Schema.Types.Mixed,
        default: null
    },
    messages: [{
        direction: { type: String, enum: ["inbound", "outbound"], required: true },
        text: String,
        ts: { type: Date, default: Date.now }
    }]
}, { timestamps: true });

export default mongoose.model("ChatContext", ChatContextSchema);
