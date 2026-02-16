// ======================================================
// 🧱 Importações principais
// ======================================================
// import "./mongooseTrap.js";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import helmet from "helmet";
import http from "http";
//import "./mongooseGuards.js";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import { followupEvents, followupQueue } from "./config/bullConfig.js";
process.env.TZ = 'America/Sao_Paulo';

// ======================================================
// 🔧 Configurações internas e serviços
// ======================================================
import { initializeSocket } from "./config/socket.js";
import Followup from "./models/Followup.js";
import { getRedis, startRedis } from "./services/redisClient.js";
import { registerWebhook } from "./services/sicoobService.js";
import { sanitizeStack } from './middleware/sanitize.js';
import salesRoutes from './routes/sales.js';
import { startLearningCron } from "./crons/learningCron.js";

// ======================================================
// 🧩 BullMQ e Painel Bull Board
// ======================================================
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import * as BullMQ from "bullmq";
const { Queue, QueueEvents } = BullMQ;

import "./models/index.js";
// ======================================================
// 📦 Rotas
// ======================================================
import adminRoutes from "./routes/admin.js";
import amandaRoutes from "./routes/aiAmanda.js";
import analitycsRoutes from "./routes/analytics.js";
import appointmentRoutes from "./routes/appointment.js";
import authRoutes from "./routes/auth.js";
import doctorRoutes from "./routes/doctor.js";
import evolutionRoutes from "./routes/evolution.js";
import followupRoutes from "./routes/followup.js";
import googleAdsRoutes from "./routes/google-ads.js";
import googleAdsAuthRoutes from "./routes/google-auth.js";
import { default as leadRoutes, default as leadsRouter } from "./routes/leads.js";
import loginRoutes from "./routes/login.js";
import marketingRoutes from "./routes/marketing.js";
import PackageRoutes from "./routes/Package.js";
import patientRoutes from "./routes/patient.js";
import PaymentRoutes from "./routes/Payment.js";
import pixRoutes from "./routes/pix.js";
import proxyMediaRoutes from "./routes/proxyMedia.js";
import reportsRoutes from "./routes/reports/index.js";
import signupRoutes from "./routes/signup.js";
import specialtyRouter from "./routes/specialty.js";
import UserRoutes from "./routes/user.js";
import whatsappRoutes from "./routes/whatsapp.js";
import aiRoutes from "./routes/ai.js";
import diagnosticRouter from './routes/whatsapp/diagnostic.js';
import protocolRoutes from './routes/protocol.js';
import expenseRoutes from './routes/financial/expense.js';
import cashflowRoutes from './routes/financial/cashflow.js';
import { scheduleMonthlyCommissions } from './jobs/scheduledTasks.js';
import planningRoutes from './routes/planning.js';
import provisionamentoRoutes from './routes/provisionamento.js';
import preAgendamentoRoutes from './routes/preAgendamento.js';
import { iniciarJobConfirmacao } from './jobs/confirmacaoJob.js';
import { scheduleDailyAlerts } from './jobs/dailyAlerts.js';
import compression from 'compression';
import importFromAgendaRouter from './routes/importFromAgenda.js';
import dashboardRoutes from './routes/dashboard.js';
import financialAnalyticsRoutes from './routes/analytics/financial.routes.js';
import insuranceGuidesRoutes from './routes/insuranceGuides.js';
import convenioPackagesRoutes from './routes/convenioPackages.js';

// ======================================================
// 🧭 Inicialização base
// ======================================================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "./.env") });

const app = express();
const server = http.createServer(app);
const io = initializeSocket(server);

app.set("io", io);

console.log("🖥️ INSTANCE INFO:", {
  nodeAppInstance: process.env.NODE_APP_INSTANCE, // PM2 cluster ID
  pmId: process.env.pm_id,
  instances: process.env.instances,
  isCluster: process.env.NODE_APP_INSTANCE !== undefined
});

// 🔹 Iniciar cron jobs
scheduleMonthlyCommissions();
iniciarJobConfirmacao();
scheduleDailyAlerts();

const PORT = process.env.PORT || 5000;

// ======================================================
// 🔍 Captura global de erros não tratados
// ======================================================
process.on("unhandledRejection", (err) => {
  if (String(err).includes("127.0.0.1:6379")) return;
  console.error("💥 UnhandledRejection:", err);
});
process.on("error", (err) => {
  if (String(err).includes("127.0.0.1:6379")) return;
  console.error("💥 Redis/BullMQ error:", err);
});

// ======================================================
// 🔒 Middlewares globais
// ======================================================
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: false,
  })
);
app.use(...sanitizeStack());
// 🔹 Compressão gzip/brotli para reduzir tamanho das respostas
app.use(compression({
  level: 6, // Nível de compressão (1-9, 6 é o equilíbrio ideal)
  threshold: 1024, // Só comprime respostas > 1KB
  filter: (req, res) => {
    // Não comprimir se o cliente não aceitar
    if (req.headers['x-no-compression']) return false;
    // Usar filtro padrão para outros casos
    return compression.filter(req, res);
  }
}));

const allowedOrigins = [
  "http://localhost:5174",
  "https://app.clinicafonoinova.com.br",
  "https://fono-inova-crm-front.vercel.app",
  "http://localhost:5000",
  "http://localhost:5173",
  "https://agenda-clinica-fono-inova.web.app", // ← ADICIONAR ISSO!
  "https://agenda-clinica-fono-inova.firebaseapp.com",
];

const corsOptions = {
  origin: true, // ← Permite TODAS as origens (temporário!)
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(
  cors(corsOptions)
);
app.options("*", cors(corsOptions));

// Logger simples
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} → ${req.path}`);
  next();
});

// ======================================================
// 🌐 Rotas principais (ordem importa!)
// ======================================================

app.use("/api", proxyMediaRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/signup", signupRoutes);
app.use("/api/login", loginRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/doctors", doctorRoutes);
app.use("/api/patients", patientRoutes);
app.use("/api/appointments", appointmentRoutes);
app.use("/api/evolutions", evolutionRoutes);
app.use("/api/leads", leadsRouter);
app.use("/api/packages", PackageRoutes);
app.use("/api/payments", PaymentRoutes);
app.use("/api/users", UserRoutes);
app.use("/api/specialties", specialtyRouter);
app.use("/api/analytics", analitycsRoutes);
app.use("/api/google-ads", googleAdsRoutes);
app.use("/api/google-ads/auth", googleAdsAuthRoutes);
app.use("/api/amanda", amandaRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/leads', leadRoutes);
app.use("/api/ai", aiRoutes);
app.use('/api/diagnostic', diagnosticRouter);
app.use('/api/protocols', protocolRoutes);
app.use('/api/expenses', expenseRoutes);
app.use('/api/cashflow', cashflowRoutes);
app.use('/api/planning', planningRoutes);
app.use('/api/pre-agendamento', preAgendamentoRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/sales', salesRoutes);
app.use('/api/provisionamento', provisionamentoRoutes);
app.use('/api/analytics/financial', financialAnalyticsRoutes);
app.use('/api/insurance-guides', insuranceGuidesRoutes);
app.use('/api/convenio-packages', convenioPackagesRoutes);

// ✅ PIX webhook agora ativo, sem fallback duplicado
app.use("/api/pix", pixRoutes);

app.use("/api/whatsapp", whatsappRoutes);
app.use("/api/followups", followupRoutes);
app.use("/api/marketing", marketingRoutes);
app.use('/api', importFromAgendaRouter);

// ======================================================
// 💚 Health Check
// ======================================================
app.get("/health", (_, res) =>
  res.status(200).json({ status: "ok", timestamp: new Date() })
);

// ======================================================
// 👀 Watcher de Followups (Socket.IO)
// ======================================================
function initFollowupWatcher() {
  try {
    console.log("👀 Iniciando watcher de Followups...");
    Followup.watch().on("change", async (change) => {
      if (
        change.operationType === "update" &&
        change.updateDescription?.updatedFields?.status
      ) {
        const updatedFollowup = await Followup.findById(
          change.documentKey._id
        ).populate("lead");

        io.emit("whatsapp-message", {
          leadId: updatedFollowup.lead?._id,
          status: updatedFollowup.status,
          message: updatedFollowup.message,
        });
      }
    });
  } catch (err) {
    console.error("⚠️ Erro ao iniciar watcher Followup:", err.message);
  }
}

// ======================================================
// 🧠 Inicializa Redis + Mongo + Workers (com PING check)
// ======================================================
(async () => {
  try {
    console.log("🔄 Iniciando conexão Redis...");
    await startRedis();

    const redisClient = getRedis();
    await redisClient.ping();

    // Workers e Crons
    await import("./workers/followup.worker.js");
    await import("./workers/followup.cron.js");
    await import("./jobs/followup.analytics.cron.js");
    await import("./crons/responseTracking.cron.js");

    // Conexão MongoDB
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ Connected to MongoDB");

    // 👉 AQUI LIGAMOS SEU CRON DIÁRIO DE APRENDIZADO
    startLearningCron();

    // 🧪 CRON DE REGRESSÃO DIÁRIA (00:00)
    const { startRegressionCron } = await import("./crons/regressionCron.js");
    startRegressionCron();

    // Registrar Webhook PIX no Sicoob
    try {
      await registerWebhook();
      console.log("🔗 Webhook PIX registrado com sucesso");
    } catch (err) {
      console.warn("⚠️ Falha ao registrar webhook PIX:", err.message);
    }

    initFollowupWatcher();

    // Inicializa servidor
    server.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`🌐 Environment: ${process.env.NODE_ENV || "development"}`);
    });
  } catch (err) {
    console.error("❌ Erro crítico na inicialização:", err);
    process.exit(1);
  }
})();

// ======================================================
// 🎛️ Painel Bull Board (BullMQ v5)
// ======================================================
try {
  // 🔹 Eventos globais da fila
  followupEvents.on("completed", ({ jobId }) =>
    console.log(`🎯 Job ${jobId} concluído com sucesso`)
  );
  followupEvents.on("failed", ({ jobId, failedReason }) =>
    console.error(`💥 Job ${jobId} falhou: ${failedReason}`)
  );

  // 🔹 Painel Bull Board
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath("/admin/queues");

  createBullBoard({
    queues: [new BullMQAdapter(followupQueue)],
    serverAdapter,
  });

  app.use("/admin/queues", serverAdapter.getRouter());
  console.log("🖥️ Bull Board disponível em: /admin/queues");
} catch (err) {
  console.error("⚠️ Falha ao inicializar Bull Board:", err.message);
}
