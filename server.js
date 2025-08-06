import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';

// Configuração inicial
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Carrega variáveis de ambiente
dotenv.config({ path: path.resolve(__dirname, './.env') });

// Verifica variáveis essenciais
if (!process.env.MONGO_URI) {
  console.error('❌ MONGO_URI não definida no .env');
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 5000;

// *************** CONFIGURAÇÃO SIMPLIFICADA DE CORS ***************
const allowedOrigins = [
  'https://app.clinicafonoinova.com.br',
  'https://fono-inova-combr.vercel.app',
  'http://localhost:5173'
];

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.options('*', cors()); // Pré-flight para todas rotas
// ***************************************************************

// Middlewares essenciais
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Conexão com MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
  });

// Importação de rotas (usando import dinâmico para melhor organização)
const routes = [
  './routes/admin.js',
  './routes/appointment.js',
  './routes/doctor.js',
  './routes/evolution.js',
  './routes/Leads.js',
  './routes/login.js',
  './routes/Package.js',
  './routes/patient.js',
  './routes/Payment.js',
  './routes/signup.js',
  './routes/specialty.js',
  './routes/user.js'
];

// Carrega todas as rotas dinamicamente
await Promise.all(routes.map(async (routePath) => {
  const route = await import(routePath);
  const basePath = routePath.split('/').pop().replace('.js', '');
  app.use(`/api/${basePath.replace('routes.', '')}`, route.default);
}));

// *************** CONFIGURAÇÃO DE ARQUIVOS ESTÁTICOS ***************
const frontendPath = path.join(__dirname, '../frontend/dist');

// Middleware para arquivos estáticos
app.use(express.static(frontendPath, {
  index: false, // Impede que o index.html seja servido automaticamente
  extensions: ['html', 'js', 'css', 'png', 'jpg', 'jpeg', 'gif', 'svg'],
  setHeaders: (res) => {
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
  }
}));

// Fallback para SPA - Todas as rotas não tratadas retornam o index.html
app.get('*', (req, res, next) => {
  // Ignora rotas da API
  if (req.path.startsWith('/api')) return next();
  
  // Verifica se o arquivo existe
  const filePath = path.join(frontendPath, req.path);
  
  // Se for um arquivo que existe (imagem, css, js), serve ele
  if (express.static.mime.lookup(filePath) && !req.path.endsWith('/')) {
    return express.static(frontendPath)(req, res, next);
  }
  
  // Caso contrário, serve o index.html
  res.sendFile(path.join(frontendPath, 'index.html'));
});
// ***************************************************************

// Middleware de erro (DEVE vir depois das rotas)
import { errorHandler } from './utils/errorHandler.js';
app.use(errorHandler);

// Inicia o servidor
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔒 CORS allowed for: ${allowedOrigins.join(', ')}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
}).on('error', err => {
  console.error('💥 Server failed to start:', err);
  process.exit(1);
});

// Tratamento de encerramento gracioso
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('🔴 Server closed');
    process.exit(0);
  });
});