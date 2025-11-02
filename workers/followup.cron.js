// crons/followup.cron.js
import mongoose from "mongoose";
import { followupQueue } from "../config/bullConfig.js";
import { redisConnection } from "../config/redisConnection.js";
import Followup from "../models/Followup.js";

await mongoose.connect(process.env.MONGO_URI);

const LOCK_KEY = "cron:followups:scan-lock";
const LOCK_TTL_SECONDS = 60;

async function withLock(key, ttl, fn) {
  const ok = await redisConnection.set(key, "1", "EX", ttl, "NX");
  if (ok !== "OK") return;
  try { await fn(); } finally { try { await redisConnection.del(key); } catch { } }
}

async function dispatchPendingFollowups() {
  await withLock(LOCK_KEY, LOCK_TTL_SECONDS, async () => {
    const now = new Date();
    const pend = await Followup.find({ status: "scheduled", scheduledAt: { $lte: now } })
      .sort({ scheduledAt: 1 })
      .limit(200)
      .lean();

    if (!pend.length) {
      console.log("⏳ Nenhum follow-up pendente...");
      return;
    }

    console.log(`📬 ${pend.length} follow-ups prontos para envio.`);
    for (const f of pend) {
      await followupQueue.add(
        "followup",
        { followupId: String(f._id) },
        { jobId: `fu:${f._id}` } // idempotência
      );
    }
  });
}

setInterval(dispatchPendingFollowups, 5 * 60 * 1000);
dispatchPendingFollowups();
