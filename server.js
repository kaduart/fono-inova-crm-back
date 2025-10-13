import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import helmet from "helmet";
import http from "http";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import { initializeSocket } from "./config/socket.js";
import Followup from "./models/Followup.js";
import { startRedis } from "./services/redisClient.js";
import { registerWebhook } from "./services/sicoobService.js"; // ✅ import certo

// 🧩 Painel Bull Board
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { Queue } from "bullmq";

// Rotas
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
import pixRoutes from "./routes/pix.js";
import signupRoutes from "./routes/signup.js";
import specialtyRouter from "./routes/specialty.js";
import UserRoutes from "./routes/user.js";
import whatsappRoutes from "./routes/whatsapp.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "./.env") });

const app = express();
const server = http.createServer(app);
const io = initializeSocket(server);
const PORT = process.env.PORT || 5000;

// ✅ Inicializa o Redis com teste de saúde
(async () => {
  try {
    console.log("🔄 Iniciando conexão Redis...");
    await startRedis();
    console.log("🧩 Redis inicializado com sucesso!");
  } catch (err) {
    console.error("❌ Falha crítica ao inicializar o Redis:", err.message);
    if (process.env.NODE_ENV === "production") {
      console.error("🚫 Abortando inicialização — Redis é obrigatório em produção.");
      process.exit(1);
    } else {
      console.warn("⚠️ Continuando sem Redis (modo desenvolvimento).");
    }
  }

  // 🔗 Conexão MongoDB
  mongoose
    .connect(process.env.MONGO_URI)
    .then(async () => {
      console.log("✅ Connected to MongoDB");

      try {
        await registerWebhook();
        console.log("🔗 Webhook PIX registrado com sucesso");
      } catch {
        console.warn("⚠️ Falha ao registrar webhook PIX (sem travar o servidor)");
      }

      initFollowupWatcher();

      // 🚀 Inicia o servidor só depois que tudo essencial estiver pronto
      server.listen(PORT, () => {
        console.log(`🚀 Server running on port ${PORT}`);
        console.log(`🌐 Environment: ${process.env.NODE_ENV || "development"}`);
      });
    })
    .catch((err) => {
      console.error("❌ MongoDB connection error:", err);
      process.exit(1);
    });
})();


// 🔒 Middlewares globais
app.use(helmet());
app.use(express.json({ limit: "2mb" }));

// ✅ CORS
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
        : cb(null, false),
    credentials: true,
  })
);
app.options("*", cors());

// 🧾 Logger
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} → ${req.path}`);
  next();
});

// ✅ Rotas principais
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
app.use("/api/pix", pixRoutes);
app.use("/api/whatsapp", whatsappRoutes);
app.use("/api/followups", followupRoutes);

// ✅ Health check
app.get("/health", (req, res) =>
  res.status(200).json({ status: "ok", timestamp: new Date() })
);

// 🧩 Painel Bull Board (Visualizador de Filas)
try {
const followupQueue = new Queue("followupQueue", {
  connection: process.env.REDIS_URL
    ? {
        url: process.env.REDIS_URL,
        tls: { rejectUnauthorized: false }, // Upstash exige TLS
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      }
    : {
        host: process.env.REDIS_HOST || "127.0.0.1",
        port: process.env.REDIS_PORT || 6379,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      },
});

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

// 🧩 Watcher MongoDB → emite eventos em tempo real
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
    console.error("⚠️ Erro ao iniciar watcher Followup:", err);
  }
}

import "./jobs/followup.analytics.cron.js";

