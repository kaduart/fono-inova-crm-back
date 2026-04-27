import { Server } from "socket.io";
import { redisConnection } from "./redisConnection.js";

let io = null; // Inicia como null
const REDIS_SOCKET_CHANNEL = "socket:emit";

export const initializeSocket = (server) => {
  // ✅ SINGLETON: Se já existe, retorna a instância existente
  if (io) {
    console.log("⚡ Socket.IO já inicializado, reutilizando instância");
    return io;
  }
  console.log("IO INIT:", io);
  const isDev = process.env.NODE_ENV === "development";

  io = new Server(server, {
    cors: {
      origin: [
        "http://localhost:5173",
        "http://localhost:3000",
        "https://app.clinicafonoinova.com.br",
        "https://fono-inova-crm-front.vercel.app",
        "https://agenda.clinicafonoinova.com.br",
        "https://www.clinicafonoinova.com.br",
        "https://fono-inova-crm-back.onrender.com",
      ],
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      credentials: true,
    },
    transports: ["polling", "websocket"],
    allowEIO3: true,
    pingTimeout: 60000,
    pingInterval: 25000,
    // 🆕 IMPORTANTE: Configurações para funcionar atrás de proxy (Render, Nginx, etc)
    perMessageDeflate: false,
    httpCompression: true,
    // Permitir upgrade de conexão para WebSocket
    allowUpgrades: true,
    upgradeTimeout: 10000,
  });

  // 🔄 REDIS BRIDGE: Workers sem Socket.IO publicam aqui; web server repassa
  if (redisConnection) {
    try {
      const subscriber = redisConnection.duplicate();
      subscriber.subscribe(REDIS_SOCKET_CHANNEL, (err) => {
        if (err) {
          console.error("❌ Falha ao subscrever no canal Redis socket:emit:", err.message);
        } else {
          console.log("📡 Redis bridge ativo no canal:", REDIS_SOCKET_CHANNEL);
        }
      });

      subscriber.on("message", (channel, message) => {
        if (channel !== REDIS_SOCKET_CHANNEL || !io) return;
        try {
          const { event, payload } = JSON.parse(message);
          io.emit(event, payload);
          console.log(`📡 [Redis Bridge] Rebroadcast ${event} → ${io.engine?.clientsCount ?? 0} clientes`);
        } catch (parseErr) {
          console.error("❌ Redis bridge parse error:", parseErr.message);
        }
      });

      subscriber.on("error", (err) => {
        console.error("❌ Redis subscriber error:", err.message);
      });
    } catch (err) {
      console.error("❌ Erro ao configurar Redis bridge:", err.message);
    }
  }

  io.on("connection", (socket) => {
    console.log("⚡ Novo cliente conectado:", socket.id);
    console.log("👥 Total de clientes:", io.engine.clientsCount); // Log útil

    socket.onAny((event, data) => {
      if (event !== "ping") {
        console.log("📨 [CLIENTE → SERVER]", event);
      }
    });

    socket.on("ping", () => {
      socket.emit("pong");
    });

    // 🔄 REBROADCAST: Atualizações de agendamentos para todos os clientes
    socket.on("appointmentUpdated", (data) => {
      console.log("📡 [SERVER] appointmentUpdated recebido, broadcasting...", data);
      socket.broadcast.emit("appointmentUpdated", data);
    });

    socket.on("appointmentCreated", (data) => {
      console.log("📡 [SERVER] appointmentCreated recebido, broadcasting...", data);
      socket.broadcast.emit("appointmentCreated", data);
    });

    socket.on("appointmentDeleted", (data) => {
      console.log("📡 [SERVER] appointmentDeleted recebido, broadcasting...", data);
      socket.broadcast.emit("appointmentDeleted", data);
    });

    socket.on("disconnect", (reason) => {
      console.log(`⚠️ Cliente desconectado (${reason})`);
    });
  });

  return io;
};

export const getIo = () => {
  if (!io) {
    console.warn("⚠️ getIo() chamado antes de initializeSocket() — retornando null");
    return null;
  }
  return io;
};

/**
 * 🔄 Emite evento via Socket.IO se disponível (monolítico/local),
 *    ou publica no Redis para o web server rebroadcast (workers no Render).
 */
export const emitSocketEvent = async (event, payload) => {
  const socketIo = getIo();
  const preview = JSON.stringify(payload).substring(0, 180);
  
  if (socketIo) {
    const clients = socketIo.engine?.clientsCount ?? 0;
    socketIo.emit(event, payload);
    console.log(`📡 [EMIT] ${event} → ${clients} clientes | payload: ${preview}`);
    return { emitted: true, via: "socket.io", clients };
  }

  // Fallback: worker sem Socket.IO → publica no Redis
  if (redisConnection) {
    try {
      await redisConnection.publish(REDIS_SOCKET_CHANNEL, JSON.stringify({ event, payload }));
      console.log(`📡 [EMIT REDIS] ${event} → canal socket:emit | payload: ${preview}`);
      return { emitted: true, via: "redis" };
    } catch (err) {
      console.error(`❌ emitSocketEvent Redis falhou (${event}):`, err.message);
      return { emitted: false, error: err.message };
    }
  }

  console.warn(`⚠️ emitSocketEvent: nem Socket.IO nem Redis disponíveis (${event})`);
  return { emitted: false, error: "No transport available" };
};