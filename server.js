import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import mongoose from 'mongoose';
import path from 'path';
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
import adminRoutes from './routes/admin.js';
import appointmentRoutes from './routes/appointment.js';
import authRoutes from './routes/auth.js';
import doctorRoutes from './routes/doctor.js';
import evolutionRoutes from './routes/evolution.js';
import leadsRouter from './routes/Leads.js';
import loginRoutes from './routes/login.js';
import PackageRoutes from './routes/Package.js';
import patientRoutes from './routes/patient.js';
import PaymentRoutes from './routes/Payment.js';
import signupRoutes from './routes/signup.js';
import specialtyRouter from './routes/specialty.js';
import UserRoutes from './routes/user.js';

// Error Handler
import { errorHandler } from './utils/errorHandler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, './.env') });

const app = express();
const PORT = process.env.PORT || 5000;

// *************** CORS CONFIGURAÇÃO AVANÇADA ***************
const allowedOrigins = [
  'https://app.clinicafonoinova.com.br',
  'https://fono-inova-combr.vercel.app',
  'http://localhost:5173'
];

const corsOptions = {
  origin: function (origin, callback) {
    // Permite requisições sem origin (mobile apps, curl, etc)
    if (!origin) return callback(null, true);

    // Normaliza URLs para comparar (remove barra final)
    const normalizeUrl = url => url.endsWith('/') ? url.slice(0, -1) : url;
    const normalizedOrigin = normalizeUrl(origin);

    const isAllowed = allowedOrigins.some(allowed =>
      normalizedOrigin === normalizeUrl(allowed)
    );


    if (isAllowed) {
      callback(null, true);
    } else {
      callback(new Error('Acesso não permitido por CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With'],
  credentials: true,
  optionsSuccessStatus: 204
};

// Middleware CORS principal (DEVE vir primeiro)
app.use(cors(corsOptions));

// Middleware de headers manuais
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.some(o => o.includes(origin.replace(/\/$/, '')))) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Vary', 'Origin');

  // Responde imediatamente para OPTIONS
  if (req.method === 'OPTIONS') return res.status(204).end();

  next();
});

// Rota específica para pré-flight
app.options('*', cors(corsOptions));
// *********************************************************

app.use(express.json());

// Conexão com MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// Rotas
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

// Middleware de erro (DEVE vir depois das rotas)
app.use(errorHandler);

// Configuração para produção
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../frontend/dist')));

  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
  });
}

// Inicia o servidor
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔒 CORS allowed for: ${allowedOrigins.join(', ')}`);
}).on('error', err => {
  console.error('💥 Server failed to start:', err);
});