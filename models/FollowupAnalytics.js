import mongoose from "mongoose";

const followupAnalyticsSchema = new mongoose.Schema({
    date: { type: Date, default: Date.now },
    total: Number,
    sent: Number,
    responded: Number,
    failed: Number,
    conversionRate: Number,
    bestHour: Number,
    bestChannel: String,
});

export default mongoose.model("FollowupAnalytics", followupAnalyticsSchema);
