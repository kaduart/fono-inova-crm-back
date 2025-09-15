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

const allowedOrigins = [
  'https://app.clinicafonoinova.com.br',
  'https://fono-inova-combr.vercel.app',
  'http://localhost:3000'
];

// CORS
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn('CORS blocked for origin:', origin);
      callback(null, false); // não dispara erro, mas bloqueia
    }
  },
  credentials: true,
  methods: ['GET','POST','PUT','DELETE','OPTIONS','PATCH'],
  allowedHeaders: [
    'Content-Type', 'Authorization', 'Accept', 'X-Requested-With'
  ]
};
app.use(cors(corsOptions));
app.use(express.json());

// Logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

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
app.use('/api/analytics', analitycsRoutes);
app.use('/api/google-ads', googleAdsRoutes);
app.use('/api/google-ads/auth', googleAdsAuthRoutes);
app.use('/api/pix', pixRoutes);

// Health check
app.get('/api/test', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

// ---------------- PIX WEBHOOK ----------------
app.post('/api/pix/webhook', (req, res) => {
  try {
    const payload = req.body;
    console.log('📩 Webhook recebido do Sicoob:', JSON.stringify(payload, null, 2));
    // Resposta imediata
    res.status(200).json({ mensagem: "Notificação recebida com sucesso" });

    if (payload?.pix && Array.isArray(payload.pix)) {
      const io = getIo();
      payload.pix.forEach(pix => {
        const formattedPix = {
          id: pix.txid || Date.now().toString(),
          amount: parseFloat(pix.valor) || 0,
          date: new Date(pix.horario || Date.now()),
          payer: pix.pagador || 'Não informado',
          status: 'recebido'
        };
        console.log('💸 Pix processado:', formattedPix);
        io.emit('pix-received', formattedPix);
      });
    }
  } catch (error) {
    console.error('❌ Erro ao processar webhook Pix:', error);
  }
});

// Teste de registro de webhook
app.post('/api/test-webhook', async (req, res) => {
  try {
    const webhookUrl = process.env.NODE_ENV === 'production'
      ? `${process.env.BACKEND_URL_PRD}/api/pix/webhook`
      : `https://e056240c5e87.ngrok-free.app/api/pix/webhook`;
    const result = await registerWebhook(webhookUrl);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message, details: error.response?.data });
  }
});

// Info webhook
app.get('/api/webhook-info', (req, res) => {
  const webhookUrl = process.env.NODE_ENV === 'production'
    ? `${process.env.BACKEND_URL_PRD}/api/pix/webhook`
    : `https://e056240c5e87.ngrok-free.app/api/pix/webhook`;
  res.json({
    webhookUrl,
    codigoTipoMovimento: 7,
    descricaoTipoMovimento: 'Pagamento (Baixa operacional)',
    codigoPeriodoMovimento: 1,
    descricaoPeriodoMovimento: 'Movimento atual (D0)',
    manualRegistrationUrl: 'https://developers.sicoob.com.br',
    environment: process.env.SICOOB_ENVIRONMENT || 'sandbox'
  });
});

// Conectar MongoDB + registrar webhook
mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log('✅ Connected to MongoDB');
    registerWebhook(
      process.env.NODE_ENV === 'production'
        ? `${process.env.BACKEND_URL_PRD}/api/pix/webhook`
        : `https://e056240c5e87.ngrok-free.app/api/pix/webhook`
    );
  })
  .catch(err => console.error('❌ MongoDB connection error:', err));

// Servir frontend produção
/* if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../frontend/dist')));
  app.get('*', (req, res, next) => {
    if (!req.path.startsWith('/api/')) res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
    else next();
  });
} */

// Error handler
app.use(errorHandler);

// Teste conexão Sicoob
app.get('/api/test-sicoob-connection', async (req, res) => {
  try {
    const token = await getSicoobAccessToken();
    if (token) {
      res.json({ success: true, message: 'Conectividade com Sicoob OK', token: token.substring(0, 50) + '...' });
    } else {
      res.status(500).json({ success: false, message: 'Falha na conectividade com Sicoob' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message, details: err.response?.data });
  }
});

// Iniciar servidor
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
}).on('error', err => console.error('💥 Server failed to start:', err));
