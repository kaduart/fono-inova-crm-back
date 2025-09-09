import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import http from 'http';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import { getSicoobAccessToken, registerWebhook } from './services/sicoobService.js';

// Models
import './models/Doctor.js';
import './models/Package.js';
import './models/Patient.js';
import './models/Payment.js';
import './models/Session.js';
import './models/Specialty.js';
import './models/User.js';

// Routes
import { getIo, initializeSocket } from "./config/socket.js";
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
import pixRoutes from './routes/pix.js';
import signupRoutes from './routes/signup.js';
import specialtyRouter from './routes/specialty.js';
import UserRoutes from './routes/user.js';
import { errorHandler } from './utils/errorHandler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, './.env') });

const app = express();
const server = http.createServer(app);

const io = initializeSocket(server);

io.on('connection', (socket) => {
  console.log('⚡ Frontend conectado:', socket.id);
});

const PORT = process.env.PORT || 5000;

// CORS Configuration
const corsOptions = {
  origin: function (origin, callback) {
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

app.use(cors(corsOptions));
app.use(express.json());

// Logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// API Routes
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
app.use('/api/google-ads/auth', googleAdsAuthRoutes);
app.use('/api/pix', pixRoutes);

// Health check
app.get('/api/test', (req, res) => {
  res.send({ status: 'ok', timestamp: new Date() });
});

// Rota para testar registro de webhook
app.post('/api/test-webhook', async (req, res) => {
  try {
    const webhookUrl = `https://e056240c5e87.ngrok-free.app/api/pix/webhook`;
    const result = await registerWebhook(webhookUrl);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      details: error.response?.data
    });
  }
});

// Servir frontend em produção
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../frontend/dist')));

  app.get('*', (req, res, next) => {
    if (!req.path.startsWith('/api/')) {
      res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
    } else {
      next();
    }
  });
}

// Error handler
app.use(errorHandler);

// Rota para obter informações de configuração do webhook
app.get('/api/webhook-info', (req, res) => {
  const webhookUrl = process.env.NODE_ENV === 'production'
    ? `${process.env.FRONTEND_URL_PRD}/api/pix/webhook`
    : `https://e056240c5e87.ngrok-free.app/api/pix/webhook`;

  res.json({
    webhookUrl: webhookUrl,
    codigoTipoMovimento: 7,
    descricaoTipoMovimento: 'Pagamento (Baixa operacional)',
    codigoPeriodoMovimento: 1,
    descricaoPeriodoMovimento: 'Movimento atual (D0)',
    manualRegistrationUrl: 'https://developers.sicoob.com.br',
    environment: process.env.SICOOB_ENVIRONMENT || 'sandbox'
  });
});

// Registrar webhook Sicoob automaticamente
const registerSicoobWebhook = async () => {
  try {
    let webhookUrl;

    if (process.env.NODE_ENV === 'production') {
      webhookUrl = `${process.env.FRONTEND_URL_PRD}/api/pix/webhook`;
    } else {
      webhookUrl = `https://e056240c5e87.ngrok-free.app/api/pix/webhook`;
    }

    console.log('📝 Tentando registrar webhook Sicoob:', webhookUrl);

    const result = await registerWebhook(webhookUrl);

    if (result && result.success) {
      console.log('✅ Webhook Sicoob registrado com sucesso');
    } else {
      console.log('ℹ️ Registro automático não suportado. Registre manualmente.');
      console.log('ℹ️ URL para registro manual:', webhookUrl);
    }

  } catch (error) {
    console.error('❌ Erro ao registrar webhook Sicoob:', error.message);
  }
};

// Conectar ao MongoDB e registrar webhook
mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log('✅ Connected to MongoDB');
    registerSicoobWebhook();
  })
  .catch(err => console.error('❌ MongoDB connection error:', err));

// Iniciar servidor
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
}).on('error', err => {
  console.error('💥 Server failed to start:', err);
});