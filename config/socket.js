import { Server } from "socket.io";

let io;

export const initializeSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: [
        "http://localhost:5173",
        "https://app.clinicafonoinova.com.br",
        "https://fono-inova-crm-front.vercel.app", // ✅ corrigido
      ],
      methods: ["GET", "POST"],
      credentials: true,
      transports: ["websocket", "polling"],
    },
  });

  io.on("connection", (socket) => {
    console.log("⚡ Cliente conectado ao Socket.IO:", socket.id);

    socket.on("disconnect", () => {
      console.log("⚡ Cliente desconectado:", socket.id);
    });
  });

  return io;
};

export const getIo = () => {
  if (!io) throw new Error("❌ Socket.IO não inicializado!");
  return io;
};
