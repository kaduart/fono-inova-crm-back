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

/**
 * 🔥 GET /marketing/new-patients-today
 * Pacientes novos do dia (primeiro agendamento deles)
 * Para tela de Lançamentos/Marketing
 */
router.get("/new-patients-today", async (req, res) => {
  try {
    const { date } = req.query; // opcional: ?date=2026-03-26
    
    // Data alvo (hoje se não informar)
    const targetDate = date ? new Date(date) : new Date();
    targetDate.setHours(0, 0, 0, 0);
    
    const nextDay = new Date(targetDate);
    nextDay.setDate(nextDay.getDate() + 1);

    const Appointment = (await import("../models/Appointment.js")).default;
    const Patient = (await import("../models/Patient.js")).default;

    // 🚀 Aggregation: Primeiro agendamento de cada paciente
    const firstAppointments = await Appointment.aggregate([
      // Agrupa por paciente e pega o primeiro agendamento
      {
        $group: {
          _id: "$patient",
          firstAppointmentDate: { $min: "$createdAt" },
          firstAppointmentId: { $first: "$_id" },
          appointment: { $first: "$$ROOT" }
        }
      },
      // Filtra só quem teve primeiro agendamento no dia alvo
      {
        $match: {
          firstAppointmentDate: {
            $gte: targetDate,
            $lt: nextDay
          }
        }
      },
      // Popula dados do paciente
      {
        $lookup: {
          from: "patients",
          localField: "_id",
          foreignField: "_id",
          as: "patientData"
        }
      },
      { $unwind: "$patientData" },
      // Ordena por hora
      { $sort: { "appointment.time": 1 } },
      // Projeta só o necessário
      {
        $project: {
          patientId: "$_id",
          patientName: "$patientData.name",
          patientPhone: "$patientData.phone",
          appointmentDate: "$appointment.date",
          appointmentTime: "$appointment.time",
          specialty: "$appointment.specialty",
          doctor: "$appointment.doctor",
          firstAppointmentDate: 1,
          createdAt: "$appointment.createdAt"
        }
      }
    ]);

    // Conta por período para comparação
    const weekAgo = new Date(targetDate);
    weekAgo.setDate(weekAgo.getDate() - 7);
    
    const monthAgo = new Date(targetDate);
    monthAgo.setDate(monthAgo.getDate() - 30);

    const [weekCount, monthCount] = await Promise.all([
      // Média semanal
      Appointment.aggregate([
        { $group: { _id: "$patient", firstDate: { $min: "$createdAt" } } },
        { $match: { firstDate: { $gte: weekAgo, $lt: nextDay } } },
        { $count: "total" }
      ]),
      // Média mensal
      Appointment.aggregate([
        { $group: { _id: "$patient", firstDate: { $min: "$createdAt" } } },
        { $match: { firstDate: { $gte: monthAgo, $lt: nextDay } } },
        { $count: "total" }
      ])
    ]);

    res.json({
      success: true,
      data: {
        date: targetDate.toISOString().split('T')[0],
        count: firstAppointments.length,
        patients: firstAppointments,
        comparison: {
          weekTotal: weekCount[0]?.total || 0,
          monthTotal: monthCount[0]?.total || 0,
          dailyAverage: Math.round((monthCount[0]?.total || 0) / 30)
        }
      }
    });

  } catch (err) {
    console.error("❌ Erro em new-patients-today:", err);
    res.status(500).json({
      success: false,
      message: "Erro ao buscar pacientes novos",
      error: err.message
    });
  }
});

export default router;
