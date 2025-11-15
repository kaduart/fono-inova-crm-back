// routes/marketing.js - ROUTER COMPLETO CORRIGIDO
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
router.get("/analytics/events", async (req, res) => {
    try {
        let { startDate, endDate } = req.query;
        if (!startDate || !endDate) {
            ({ startDate, endDate } = getDefaultDates(7));
        }
        const events = await getGA4Events(startDate, endDate);
        res.json(events);
    } catch (err) {
        console.error("Erro em /analytics/events:", err);
        res.status(500).json({ error: "Erro ao buscar eventos GA4" });
    }
});

// ✅ ROTA: Performance (Dados de exemplo)
router.get("/analytics/performance", async (req, res) => {
    try {
        let { startDate, endDate } = req.query;
        if (!startDate || !endDate) {
            ({ startDate, endDate } = getDefaultDates(30));
        }

        // Dados de exemplo realistas
        const performanceData = {
            byStatus: [
                { status: "novo", count: 45, date: startDate },
                { status: "em_contato", count: 23, date: startDate },
                { status: "convertido", count: 12, date: startDate },
                { status: "perdido", count: 8, date: startDate }
            ],
            byOrigin: [
                { origin: "google_ads", count: 35, percentage: 42 },
                { origin: "organic", count: 28, percentage: 33 },
                { origin: "social", count: 12, percentage: 14 },
                { origin: "direct", count: 9, percentage: 11 }
            ],
            byDate: generateDateRangeData(startDate, endDate),
            summary: {
                totalLeads: 84,
                conversionRate: 14.3,
                avgResponseTime: "2.5h"
            }
        };

        res.json(performanceData);
    } catch (err) {
        console.error("Erro em /analytics/performance:", err);
        res.status(500).json({ error: "Erro ao buscar dados de performance" });
    }
});

// ✅ ROTA: Google Ads (Dados de exemplo até configurar API)
router.get("/google-ads/campaigns", async (req, res) => {
    try {
        // Dados de exemplo realistas do Google Ads
        const campaigns = [
            {
                id: 1,
                name: "Campanha Principal - Search",
                status: "ACTIVE",
                clicks: 1450,
                impressions: 24500,
                cost: 1250.50,
                conversions: 23,
                ctr: 5.92,
                cpc: 0.86,
                conversionRate: 1.59,
                costPerConversion: 54.37
            },
            {
                id: 2,
                name: "Campanha Remarketing - Display",
                status: "ACTIVE",
                clicks: 890,
                impressions: 15600,
                cost: 780.25,
                conversions: 15,
                ctr: 5.70,
                cpc: 0.88,
                conversionRate: 1.68,
                costPerConversion: 52.02
            },
            {
                id: 3,
                name: "Campanha Branding - YouTube",
                status: "PAUSED",
                clicks: 320,
                impressions: 8900,
                cost: 450.75,
                conversions: 8,
                ctr: 3.60,
                cpc: 1.41,
                conversionRate: 2.50,
                costPerConversion: 56.34
            }
        ];

        console.log("📊 Retornando dados de exemplo do Google Ads");
        res.json(campaigns);

    } catch (err) {
        console.error("Erro em /google-ads/campaigns:", err);
        res.json([]);
    }
});

// ✅ ROTAS: Amanda Insights
router.post("/analytics/learn", async (req, res) => {
    try {
        const insights = await analyzeHistoricalConversations();
        res.json({ success: true, insights, message: "Análise completa!" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get("/analytics/insights", async (req, res) => {
    try {
        const insights = await getLatestInsights();
        res.json(insights);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Função auxiliar para gerar dados por data
function generateDateRangeData(startDate, endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const data = [];

    for (let date = new Date(start); date <= end; date.setDate(date.getDate() + 1)) {
        data.push({
            date: date.toISOString().split('T')[0],
            leads: Math.floor(Math.random() * 10) + 5,
            conversions: Math.floor(Math.random() * 3) + 1,
            contacts: Math.floor(Math.random() * 8) + 3
        });
    }

    return data;
}

export default router;