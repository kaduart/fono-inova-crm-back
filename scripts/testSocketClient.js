import { io } from "socket.io-client";

const socket = io("http://localhost:5000");

socket.on("connect", () => console.log("Conectado ao servidor Socket.IO", socket.id));
socket.on("pix-received", (data) => console.log("Pix recebido:", data));
socket.on("connect_error", (err) => console.error("Erro de conexão:", err));
