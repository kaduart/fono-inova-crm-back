// ======================================================
// 🌐 Fix WSL2: força DNS a preferir IPv4 (resolve ETIMEDOUT no undici/fetch)
// ======================================================
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

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
import { followupEvents, followupQueue, videoGenerationQueue, videoGenerationEvents } from "./config/bullConfig.js";
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
import { startMetaAdsCron } from "./crons/metaAdsSync.cron.js";

// ======================================================
// 🧩 BullMQ e Painel Bull Board
// ======================================================
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import * as BullMQ from "bullmq";
const { Queue, QueueEvents } = BullMQ;

import "./models/index.js";
import jwt from "jsonwebtoken";
import { auth } from "./middleware/auth.js";
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

import PackageRoutes from "./routes/Package.js";
import patientRoutes from "./routes/patient.js";
import patientDuplicatesRoutes from "./routes/patients/duplicates.js";
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
import financialOverviewRoutes from './routes/financial/overview.routes.js';
import financialMetricsRoutes from './routes/financial/metrics.routes.js';
import financialDashboardRoutes from './routes/financial/dashboard.routes.js';
import { scheduleMonthlyCommissions } from './jobs/scheduledTasks.js';
import { scheduleGmbCron } from './jobs/gmbScheduledTasks.js';
import { scheduleLandingPageDailyPosts } from './crons/landingPageDailyPost.js';
import planningRoutes from './routes/planning.js';
import marketingRoutes from './routes/marketing.js';
import landingPageRoutes from './routes/landingPage.routes.js';
import gmbRoutes from './routes/gmb.routes.js';
import instagramRoutes from './routes/instagram.routes.js';
import facebookRoutes from './routes/facebook.routes.js';
import videoRoutes from './routes/video.routes.js';
import spyRoutes from './routes/spy.routes.js';
import metaAdsRoutes from './routes/meta-ads.js';

import provisionamentoRoutes from './routes/provisionamento.js';
import preAgendamentoRoutes from './routes/preAgendamento.js';
import notificationRoutes from './routes/notifications.js';
import { iniciarJobConfirmacao } from './jobs/confirmacaoJob.js';
import { scheduleDailyAlerts } from './jobs/dailyAlerts.js';
import compression from 'compression';
import importFromAgendaRouter from './routes/importFromAgenda.js';
import dashboardRoutes from './routes/dashboard.js';
import financialAnalyticsRoutes from './routes/analytics/financial.routes.js';
import insuranceGuidesRoutes from './routes/insuranceGuides.js';
import convenioPackagesRoutes from './routes/convenioPackages.js';
import convenioRoutes from './routes/financial/convenio.routes.js';
import reminderRoutes from './routes/reminder.js';
import whatsappWebRoutes from './routes/whatsappWeb.js';
import whatsappWebService from './services/whatsappWebService.js';

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
scheduleGmbCron(); // ← Inicia cron do GMB (geração + envio ao Make)
scheduleLandingPageDailyPosts(); // ← Inicia cron de posts automáticos para LPs

// 🔹 WhatsApp Web (Puppeteer) - sessao persistente
whatsappWebService.initialize().catch(err => console.error('[WhatsAppWeb] Erro ao inicializar:', err.message));

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
// Middleware para log de requisições grandes (debug)
app.use((req, res, next) => {
    const contentLength = parseInt(req.headers['content-length'] || '0');
    if (contentLength > 100000) { // Loga se maior que 100KB
        console.log('📊 [Server] Requisição grande detectada:', {
            method: req.method,
            path: req.path,
            contentLength: contentLength,
            contentType: req.headers['content-type']?.substring(0, 50)
        });
    }
    next();
});

// 🔥 Rota de upload de mídia ANTES dos middlewares de body parsing
// Importar apenas as rotas de upload
import { whatsappController } from './controllers/whatsappController.js';
import multer from 'multer';

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});

// Rotas de upload de mídia - antes do body parsing
// Adicionar CORS manualmente para essas rotas (pois estão antes do middleware global)
const corsHeaders = (req, res, next) => {
    res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
};

app.post('/api/whatsapp/send-media', corsHeaders, upload.single('file'), whatsappController.sendMedia);
app.post('/api/whatsapp/upload-media', corsHeaders, upload.single('file'), whatsappController.uploadMedia);

// Aumentar limites para suportar uploads de até 50MB
// Ignorar requisições multipart (deixar para o multer tratar)
app.use((req, res, next) => {
    if (req.headers['content-type']?.includes('multipart/form-data')) {
        return next();
    }
    express.json({ limit: '50mb' })(req, res, next);
});
app.use((req, res, next) => {
    if (req.headers['content-type']?.includes('multipart/form-data')) {
        return next();
    }
    express.urlencoded({ limit: '50mb', extended: true })(req, res, next);
});
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
  // Firebase removido - MongoDB é fonte única de verdade
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
app.use("/api/patients", patientDuplicatesRoutes);
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
app.use('/api/financial', financialOverviewRoutes);
app.use('/api/financial/v2', financialMetricsRoutes);
app.use('/api/financial/dashboard', financialDashboardRoutes);
app.use('/api/planning', planningRoutes);
app.use('/api/pre-agendamento', preAgendamentoRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/sales', salesRoutes);
app.use('/api/provisionamento', provisionamentoRoutes);
app.use('/api/analytics/financial', financialAnalyticsRoutes);
app.use('/api/insurance-guides', insuranceGuidesRoutes);
app.use('/api/convenio-packages', convenioPackagesRoutes);
app.use('/api/financial/convenio', convenioRoutes);
app.use('/api/reminders', reminderRoutes);
app.use('/api/marketing', marketingRoutes);
app.use('/api/landing-pages', landingPageRoutes);
app.use('/api/gmb', gmbRoutes);
app.use('/api/instagram', instagramRoutes);
app.use('/api/facebook', facebookRoutes);
app.use('/api/videos', videoRoutes);
app.use('/api/spy', spyRoutes);
app.use('/api/meta-ads', metaAdsRoutes);

// ✅ PIX webhook agora ativo, sem fallback duplicado
app.use("/api/pix", pixRoutes);

app.use("/api/whatsapp", whatsappRoutes);
app.use("/api/whatsapp-web", whatsappWebRoutes);
app.use("/api/followups", followupRoutes);

app.use('/api', importFromAgendaRouter);

// ======================================================
// 🔄 Renew Token (endpoint direto para o frontend)
// ======================================================
app.post('/api/renew-token', auth, (req, res) => {
  try {
    const { iat, exp, ...userData } = req.user;
    const newToken = jwt.sign(
      userData,
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    res.json({ newToken });
  } catch (error) {
    console.error('Error renewing token:', error);
    res.status(500).json({ error: 'Failed to renew token' });
  }
});

// ======================================================
// 💚 Health Check
// ======================================================
app.get("/health", (_, res) =>
  res.status(200).json({ status: "ok", timestamp: new Date() })
);

// ======================================================
// 🎨 Servir Frontend (Produção)
// ======================================================
const distPath = path.resolve(__dirname, "./dist");
app.use(express.static(distPath));
app.get("*", (req, res) => {
  // Não interfere nas rotas de API
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "Not found" });
  }
  res.sendFile(path.join(distPath, "index.html"));
});

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
    await import("./workers/video.worker.js");  // 🎬 Video pipeline worker
    await import("./workers/post.worker.js");   // 📝 Post generation worker
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
    
    // 📍 Inicializa cron do Google Meu Negócio
    await import("./crons/gmb.cron.js");
    
    // 🎯 Meta Ads Sync - Sincronização diária de campanhas
    startMetaAdsCron();
    
    // 🔁 Lead Recovery - Recuperação automática de leads (a cada 30 min)
    const { initLeadRecoveryCron } = await import("./crons/leadRecovery.cron.js");
    initLeadRecoveryCron();

    // 📲 Worker de publicação agendada — Instagram + Facebook
    const { startScheduledPublisher } = await import("./jobs/publishScheduled.js");
    startScheduledPublisher();

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
      
      // Baileys desabilitado - usando extensão Chrome para envio via WhatsApp Web
      // Para reabilitar: chamar baileysService.initialize() e escanear QR no terminal
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
  // 🔹 Eventos globais das filas
  followupEvents.on("completed", ({ jobId }) =>
    console.log(`🎯 Followup Job ${jobId} concluído`)
  );
  followupEvents.on("failed", ({ jobId, failedReason }) =>
    console.error(`💥 Followup Job ${jobId} falhou: ${failedReason}`)
  );
  
  videoGenerationEvents.on("completed", ({ jobId }) =>
    console.log(`🎬 Video Job ${jobId} concluído`)
  );
  videoGenerationEvents.on("failed", ({ jobId, failedReason }) =>
    console.error(`🎬 Video Job ${jobId} falhou: ${failedReason}`)
  );

  // 🔹 Painel Bull Board
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath("/admin/queues");

  createBullBoard({
    queues: [
      new BullMQAdapter(followupQueue),
      new BullMQAdapter(videoGenerationQueue)  // 🎬 Adicionar fila de vídeos
    ],
    serverAdapter,
  });

  app.use("/admin/queues", serverAdapter.getRouter());
  console.log("🖥️ Bull Board disponível em: /admin/queues");
} catch (err) {
  console.error("⚠️ Falha ao inicializar Bull Board:", err.message);
}
