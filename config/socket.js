import { Server } from "socket.io";

let io = null; // Inicia como null

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
        "https://app.clinicafonoinova.com.br",
        "https://fono-inova-crm-front.vercel.app",
        "https://agenda.clinicafonoinova.com.br",
        "https://www.clinicafonoinova.com.br",
      ],
      methods: ["GET", "POST"],
      credentials: true,
    },
    transports: ["polling", "websocket"], // ✅ SEMPRE aceitar ambos
    allowEIO3: true,
    pingTimeout: 60000,
    pingInterval: 25000,
  });

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

    socket.on("disconnect", (reason) => {
      console.log(`⚠️ Cliente desconectado (${reason})`);
    });
  });

  return io;
};

export const getIo = () => {
  if (!io) {
    console.error("❌ getIo() chamado antes de initializeSocket()");
    throw new Error("Socket.IO não inicializado");
  }
  return io;
};