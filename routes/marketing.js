// routes/marketing.js - ROUTER COMPLETO E CORRIGIDO
import express from "express";
import { getGA4Events, getGA4Metrics } from "../services/analytics.js";
import { analyzeHistoricalConversations, getLatestInsights } from "../services/amandaLearningService.js";
import { getFollowupAnalytics } from "../controllers/followupController.js";

const router = express.Router();

// Funções auxiliares
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

// ✅ ROTA: Overview Combinado (GA4 + Followup)
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
        const fakeRes = { 
          json: (body) => body, 
          status: () => fakeRes 
        };
        return await getFollowupAnalytics(req, fakeRes);
      })(),
    ]);

    const ga4 = {
      totalUsers: ga4Raw?.totalUsers || ga4Raw?.users || 0,
      sessions: ga4Raw?.sessions || 0,
      avgSessionDuration: ga4Raw?.avgSessionDuration || 0,
    };

    const f = followupRaw?.data || {};
    const followup = {
      sent: f.responded || f.sent || 0,
      failed: f.failed || 0,
      successRate: typeof f.successRate !== "undefined"
        ? f.successRate
        : f.total
          ? Number((((f.responded ?? f.sent ?? 0) / f.total) * 100).toFixed(1))
          : 0,
    };

    res.json({ success: true, data: { ga4, followup } });
  } catch (err) {
    console.error("❌ Erro em /marketing/overview:", err);
    res.status(500).json({ error: "Erro ao gerar overview" });
  }
});

// ✅ ROTA: Eventos GA4
router.get("/events", async (req, res) => {
  try {
    let { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      ({ startDate, endDate } = getDefaultDates(7));
    }
    const events = await getGA4Events(startDate, endDate);
    res.json(events);
  } catch (err) {
    console.error("Erro em /events:", err);
    res.status(500).json({ error: "Erro ao buscar eventos GA4" });
  }
});

// ✅ ROTA: Performance (Placeholder)
router.get("/performance", async (req, res) => {
  try {
    let { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      ({ startDate, endDate } = getDefaultDates(7));
    }
    
    // Dados de exemplo - você pode implementar com dados reais depois
    const performanceData = {
      byStatus: [
        { status: "novo", count: 45, date: startDate },
        { status: "em_contato", count: 23, date: startDate },
        { status: "convertido", count: 12, date: startDate }
      ],
      byOrigin: [
        { origin: "google_ads", count: 35 },
        { origin: "organic", count: 28 },
        { origin: "social", count: 17 }
      ]
    };
    
    res.json(performanceData);
  } catch (err) {
    console.error("Erro em /performance:", err);
    res.status(500).json({ error: "Erro ao buscar performance" });
  }
});

// ✅ ROTA: Google Ads (Placeholder)
router.get("/google-ads/campaigns", async (req, res) => {
  try {
    // Dados de exemplo do Google Ads
    const campaigns = [
      {
        id: 1,
        name: "Campanha Principal",
        status: "ACTIVE",
        clicks: 1450,
        impressions: 24500,
        cost: 1250.50,
        conversions: 23
      },
      {
        id: 2, 
        name: "Campanha Remarketing",
        status: "ACTIVE",
        clicks: 890,
        impressions: 15600,
        cost: 780.25,
        conversions: 15
      }
    ];
    
    res.json(campaigns);
  } catch (err) {
    console.error("Erro em /google-ads/campaigns:", err);
    res.status(500).json({ error: "Erro ao buscar campanhas Google Ads" });
  }
});

// ✅ ROTAS: Amanda Insights
router.post("/learn", async (req, res) => {
  try {
    const insights = await analyzeHistoricalConversations();
    res.json({ success: true, insights, message: "Análise completa!" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/insights", async (req, res) => {
  try {
    const insights = await getLatestInsights();
    res.json(insights);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;