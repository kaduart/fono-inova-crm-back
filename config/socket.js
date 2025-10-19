// config/socket.js
import { Server } from "socket.io";

let io;

export const initializeSocket = (server) => {
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
    transports: ["polling", "websocket"], // 👈 polling primeiro
    allowEIO3: true, // 👈 compatibilidade handshake
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  io.engine.on("connection_error", (err) => {
    console.error("❌ Engine.IO error:", {
      code: err.code,
      message: err.message,
      context: err.context,
    });
  });

  io.on("connection", (socket) => {
    console.log("⚡ Novo cliente conectado:", socket.id);

    socket.on("disconnect", (reason) => {
      console.log(`⚠️ Cliente desconectado (${reason})`);
    });
  });

  return io;
};

export const getIo = () => {
  if (!io) throw new Error("❌ Socket.IO não inicializado!");
  return io;
};
