// routes/marketing.js - ROUTER COMPLETO E CORRIGIDO
import express from "express";
import { getGA4Events, getGA4Metrics } from "../services/analytics.js";
import { analyzeHistoricalConversations, getLatestInsights } from "../services/amandaLearningService.js";
import { getFollowupAnalytics } from "../controllers/followupController.js";

const router = express.Router();

function formatYMD(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function getDefaultDates(daysBack = 7) {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - daysBack);
  return { startDate: formatYMD(start), endDate: formatYMD(end) };
}

router.get("/overview", async (req, res) => {
  try {
    let { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      const end = new Date();
      const start = new Date();
      start.setDate(end.getDate() - 28);
      startDate = formatYMD(start);
      endDate = formatYMD(end);
    }

    const [ga4Raw, followupRaw] = await Promise.all([
      getGA4Metrics(startDate, endDate).catch(() => null),
      (async () => {
        const fakeRes = { json: (body) => body, status: () => fakeRes };
        return await getFollowupAnalytics(req, fakeRes);
      })(),
    ]);

    const ga4 = {
      totalUsers: ga4Raw?.totalUsers || ga4Raw?.users || 0,
      sessions: ga4Raw?.sessions || 0,
      newUsers: ga4Raw?.newUsers || 0,
      bounceRate: ga4Raw?.bounceRate || 0,
      avgSessionDuration: ga4Raw?.avgSessionDuration || 0,
      conversions: ga4Raw?.conversions || 0,
    };

    res.json({
      success: true,
      data: {
        ga4,
        followup: followupRaw?.data || followupRaw || null,
        period: { startDate, endDate },
      },
    });
  } catch (error) {
    console.error("❌ Erro overview:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get("/ga4/metrics", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const data = await getGA4Metrics(startDate, endDate);
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get("/ga4/events", async (req, res) => {
  try {
    const { startDate, endDate, eventName } = req.query;
    const data = await getGA4Events(startDate, endDate, eventName);
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get("/insights", async (req, res) => {
  try {
    const insights = await getLatestInsights(10);
    res.json({ success: true, data: insights });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post("/analyze-conversations", async (req, res) => {
  try {
    const { days, phone } = req.body;
    const result = await analyzeHistoricalConversations(days || 30, phone);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
