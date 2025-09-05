import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, './.env') });


import express from 'express';
import mongoose from 'mongoose';
import { fileURLToPath } from 'url';

// Models
import './models/Doctor.js';
import './models/Package.js';
import './models/Patient.js';
import './models/Payment.js';
import './models/Session.js';
import './models/Specialty.js';
import './models/User.js';

// Routes
import { initializeSocket } from "./config/socket.js";
import adminRoutes from './routes/admin.js';
import analitycsRoutes from './routes/analytics.js';
import appointmentRoutes from './routes/appointment.js';
import authRoutes from './routes/auth.js';
import doctorRoutes from './routes/doctor.js';
import evolutionRoutes from './routes/evolution.js';
import googleAdsRoutes from './routes/google-ads.js';
import googleAdsAuthRoutes from './routes/google-auth.js';
import leadsRouter from './routes/Leads.js';
import loginRoutes from './routes/login.js';
import PackageRoutes from './routes/Package.js';
import patientRoutes from './routes/patient.js';
import PaymentRoutes from './routes/Payment.js';
import signupRoutes from './routes/signup.js';
import specialtyRouter from './routes/specialty.js';
import UserRoutes from './routes/user.js';
import pixRoutes from './routes/pix.js';
import { errorHandler } from './utils/errorHandler.js';

import http from 'http';



const app = express();
const server = http.createServer(app);

const io = initializeSocket(server);

io.on('connection', (socket) => {
  console.log('⚡ Frontend conectado:', socket.id);
});



const PORT = process.env.PORT || 5000;

// *************** CORS CONFIGURAÇÃO SIMPLIFICADA ***************
const corsOptions = {
  origin: function (origin, callback) {
    // Permitir requisições sem origin (ex: Postman) ou localhost
    if (!origin || origin.includes('localhost')) {
      return callback(null, true);
    }

    const allowedOrigins = [
      'https://app.clinicafonoinova.com.br',
      'https://fono-inova-combr.vercel.app',
    ];

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'Accept',
    'X-Requested-With',
    'X-Goog-API-Client',
    'X-Goog-User-Project'
  ],
  optionsSuccessStatus: 204
};


// Aplicar CORS para todas as rotas
app.use(cors(corsOptions));

// Middleware para logging
app.use((req, res, next) => {
  if (req.body && Object.keys(req.body).length > 0) {
    const logBody = { ...req.body };
    if (logBody.password) logBody.password = '***';
  }
  next();
});

// Middleware JSON
app.use(express.json());

// *************** ROTAS DA API - DEVEM VIR ANTES DO FRONTEND ***************
app.use('/api/auth', authRoutes);
app.use('/api/signup', signupRoutes);
app.use('/api/login', loginRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/doctors', doctorRoutes);
app.use('/api/patients', patientRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/evolutions', evolutionRoutes);
app.use('/api/leads', leadsRouter);
app.use('/api/packages', PackageRoutes);
app.use('/api/payments', PaymentRoutes);
app.use('/api/users', UserRoutes);
app.use('/api/specialties', specialtyRouter);
app.use('/api/analytics', analitycsRoutes);
app.use('/api/google-ads', googleAdsRoutes);
app.use('/api/google-ads/auth', googleAdsAuthRoutes); // Esta linha foi movida para cá
app.use('/api/pix', pixRoutes);

app.get('/api/test', (req, res) => {
  res.send({ status: 'ok', timestamp: new Date() });
});

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../frontend/dist')));
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api/')) {
      res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
    }
  });
}

app.post('/api/pix/webhook', (req, res) => {
  const io = getIo();
  io.emit('pix-received', req.body);
  res.status(200).send('OK');
});

// *************** SERVIR FRONTEND (PRODUÇÃO) - DEVE VIR DEPOIS DAS APIs ***************
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../frontend/dist')));

  // Apenas para rotas não-API
  app.get('*', (req, res, next) => {
    if (!req.path.startsWith('/api/')) {
      res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
    } else {
      next(); // Passa para o próximo middleware (errorHandler)
    }
  });
}

// *************** ERROR HANDLER ***************
app.use(errorHandler);

// *************** CONEXÃO COM MONGO ***************
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB connection error:', err));


// *************** INICIAR SERVIDOR ***************
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
}).on('error', err => {
  console.error('💥 Server failed to start:', err);
});