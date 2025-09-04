import { Server } from 'socket.io';

let io;

export const initializeSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: [
        'http://localhost:5173', // frontend dev
      ],
      methods: ['GET', 'POST'],
    },
  });

  io.on('connection', (socket) => {
    console.log('⚡ Frontend conectado:', socket.id);
  });

  return io;
};

export const getIo = () => io;
