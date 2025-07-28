import { Server } from 'socket.io';

let io: Server;

export const initializeSocket = (server: http.Server) => {
  io = new Server(server, {
    cors: {
      origin: process.env.FRONTEND_URL,
      methods: ['GET', 'POST']
    }
  });
  return io;
};

export const getIo = () => {
  if (!io) throw new Error('Socket.io não inicializado');
  return io;
};