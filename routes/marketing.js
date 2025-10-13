// routes/marketing.js
import express from "express";
import { getGA4Metrics } from "../services/analytics.js";
import { getFollowupAnalytics } from "../controllers/followupController.js";

const router = express.Router();

function formatYMD(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

router.get("/overview", async (req, res) => {
  try {
    let { startDate, endDate } = req.query;

    // 🛡️ Defaults: últimos 28 dias se não vier do front
    if (!startDate || !endDate) {
      const end = new Date(); // hoje
      const start = new Date();
      start.setDate(end.getDate() - 28);
      startDate = formatYMD(start);
      endDate = formatYMD(end);
    }

    // Executa GA4 e Follow-up em paralelo
    const [ga4Raw, followupRaw] = await Promise.all([
      getGA4Metrics(startDate, endDate).catch(() => null),
      // Reutiliza seu endpoint analítico existente (interceptando retorno)
      (async () => {
        const fakeRes = { json: (body) => body, status: () => fakeRes };
        return await getFollowupAnalytics(req, fakeRes);
      })(),
    ]);

    // Normalização para o card atual
    const ga4 = {
      totalUsers: ga4Raw?.totalUsers || ga4Raw?.users || 0,
      sessions: ga4Raw?.sessions || 0,
      avgSessionDuration: ga4Raw?.avgSessionDuration || 0,
    };

    const f = followupRaw?.data || {};
    const followup = {
      sent: f.responded || f.sent || 0,
      failed: f.failed || 0,
      successRate:
        typeof f.successRate !== "undefined"
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

export default router;
