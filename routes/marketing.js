// routes/marketing.js
import express from "express";
import { getGA4Metrics } from "../services/analytics.js";
import { getFollowupStats } from "../controllers/followupController.js";

const router = express.Router();

router.get("/overview", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const [ga4, followup] = await Promise.all([
      getGA4Metrics(startDate, endDate),
      getFollowupStats(req, res, true), // true = modo interno
    ]);

    res.json({
      success: true,
      data: {
        ga4,
        followup,
      },
    });
  } catch (err) {
    console.error("Erro em /marketing/overview:", err);
    res.status(500).json({ error: "Erro ao gerar overview" });
  }
});

export default router;
