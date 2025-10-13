// ======================================================
// 🧱 Importações principais
// ======================================================
import express from "express";
import dotenv from "dotenv";
import helmet from "helmet";
import http from "http";
import cors from "cors";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import IORedis from "ioredis";

// ======================================================
// 🔧 Configurações internas e serviços
// ======================================================
import { redisConnection } from "./config/redisConnection.js";
import { initializeSocket } from "./config/socket.js";
import Followup from "./models/Followup.js";
import { getRedis, startRedis } from "./services/redisClient.js";
import { registerWebhook } from "./services/sicoobService.js";

// ======================================================
// 🧩 BullMQ e Painel Bull Board
// ======================================================
import * as BullMQ from "bullmq";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
const { Queue, QueueEvents } = BullMQ;

// ======================================================
// 📦 Rotas
// ======================================================
import adminRoutes from "./routes/admin.js";
import analitycsRoutes from "./routes/analytics.js";
import appointmentRoutes from "./routes/appointment.js";
import authRoutes from "./routes/auth.js";
import doctorRoutes from "./routes/doctor.js";
import evolutionRoutes from "./routes/evolution.js";
import followupRoutes from "./routes/followup.js";
import googleAdsRoutes from "./routes/google-ads.js";
import googleAdsAuthRoutes from "./routes/google-auth.js";
import leadsRouter from "./routes/Leads.js";
import loginRoutes from "./routes/login.js";
import PackageRoutes from "./routes/Package.js";
import patientRoutes from "./routes/patient.js";
import PaymentRoutes from "./routes/Payment.js";
import pixRoutes from "./routes/pix.js"; // ✅ garante o endpoint /api/pix/webhook
import signupRoutes from "./routes/signup.js";
import specialtyRouter from "./routes/specialty.js";
import UserRoutes from "./routes/user.js";
import whatsappRoutes from "./routes/whatsapp.js";
import marketingRoutes from "./routes/marketing.js";

// ======================================================
// 🧭 Inicialização base
// ======================================================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "./.env") });

const app = express();
const server = http.createServer(app);
const io = initializeSocket(server);
const PORT = process.env.PORT || 5000;

// ======================================================
// 🔒 Middlewares globais
// ======================================================
app.use(helmet());
app.use(express.json({ limit: "2mb" }));

const allowedOrigins = [
  "https://app.clinicafonoinova.com.br",
  "https://fono-inova-crm-front.vercel.app",
  "http://localhost:5000",
  "http://localhost:5173",
];

app.use(
  cors({
    origin: (origin, cb) =>
      !origin || allowedOrigins.includes(origin)
        ? cb(null, true)
        : cb(new Error("Origem não permitida pelo CORS")),
    credentials: true,
  })
);

app.options("*", cors());

// Logger simples
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} → ${req.path}`);
  next();
});

// ======================================================
// 🌐 Rotas principais
// ======================================================
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
app.use("/api/pix", pixRoutes); // ✅ PIX webhook agora ativo
app.use("/api/whatsapp", whatsappRoutes);
app.use("/api/followups", followupRoutes);
app.use("/api/marketing", marketingRoutes);

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
    console.log("🔒 Redis Upstash confirmado ativo");

    // Workers e Crons
    await import("./workers/followup.worker.js");
    await import("./workers/followup.cron.js");
    await import("./jobs/followup.analytics.cron.js");

    // Conexão MongoDB
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ Connected to MongoDB");

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
  const followupQueue = new Queue("followupQueue", {
    connection: redisConnection,
  });
  const followupEvents = new QueueEvents("followupQueue", {
    connection: redisConnection,
  });

  followupEvents.on("completed", ({ jobId }) =>
    console.log(`🎯 Job ${jobId} concluído com sucesso`)
  );
  followupEvents.on("failed", ({ jobId, failedReason }) =>
    console.error(`💥 Job ${jobId} falhou: ${failedReason}`)
  );

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

// ======================================================
// 🩺 Diagnóstico de rotas e fallback
// ======================================================

// Listar todas as rotas registradas no Express
setTimeout(() => {
  console.log("📋 ROTAS REGISTRADAS NO EXPRESS:");
  app._router.stack.forEach((r) => {
    if (r.route && r.route.path) {
      console.log(`🧭 ${r.route.stack[0].method.toUpperCase()} ${r.route.path}`);
    } else if (r.name === "router" && r.handle.stack) {
      r.handle.stack.forEach((layer) => {
        if (layer.route && layer.route.path) {
          console.log(`🧭 ${layer.route.stack[0].method.toUpperCase()} ${layer.route.path}`);
        }
      });
    }
  });
}, 4000);

// Fallback temporário — se a rota do PIX não for encontrada
app.post("/api/pix/webhook-fallback", (req, res) => {
  console.log("🚨 Fallback /api/pix/webhook-fallback foi chamado!");
  res.status(200).json({ ok: true });
});
