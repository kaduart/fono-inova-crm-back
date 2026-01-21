import { Server } from "socket.io";

let io;

export const initializeSocket = (server) => {
  const isDev = process.env.NODE_ENV === "development";

  io = new Server(server, {
    cors: {
      origin: [
        "http://localhost:5173",
        "https://app.clinicafonoinova.com.br",
        "https://fono-inova-crm-front.vercel.app",
      ],
      methods: ["GET", "POST"],
      credentials: true,
    },
    transports: isDev ? ["polling", "websocket"] : ["websocket"],
    allowEIO3: true,
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  io.on("connection", (socket) => {
    console.log("⚡ Novo cliente conectado:", socket.id);

    // ✅ Debug de eventos
    socket.onAny((event, data) => {
      if (event !== "ping") { // Evita spam de log
        console.log("📨 [EVENTO VINDO DO CLIENTE]", event, data);
      }
    });

    // ✅ HEARTBEAT - responde ping com pong
    socket.on("ping", () => {
      socket.emit("pong");
    });

    socket.on("disconnect", (reason) => {
      console.log(`⚠️ Cliente desconectado (${reason})`);
    });
  });

  // ✅ Diagnóstico do servidor (emissão e clientes conectados)
  io.on("whatsapp:new_message", (data) => {
    console.log("📡 [DEBUG SERVER] Evento whatsapp:new_message foi emitido:", data);
  });

  return io;
};

export const getIo = () => {
  if (!io) throw new Error("❌ Socket.IO não inicializado!");
  return io;
};
