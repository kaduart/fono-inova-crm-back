// models/ChatContext.js
import mongoose from "mongoose";
const { Schema } = mongoose;

const ChatContextSchema = new Schema({
    lead: { type: Schema.Types.ObjectId, ref: "Leads", unique: true },
    lastSummary: { type: String, default: "" },
    lastUpdatedAt: { type: Date, default: Date.now },
    messages: [{
        direction: { type: String, enum: ["inbound", "outbound"], required: true },
        text: String,
        ts: { type: Date, default: Date.now }
    }]
}, { timestamps: true });

export default mongoose.model("ChatContext", ChatContextSchema);
