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

// Webhook endpoint para receber notificações do Sicoob
app.post('/api/pix/webhook', (req, res) => {
  try {
    console.log('📩 Webhook recebido do Sicoob:', JSON.stringify(req.body, null, 2));

    // Resposta imediata para o Sicoob
    res.status(200).json({
      mensagem: "Notificação recebida com sucesso"
    });

    // Processar a notificação em segundo plano
    processSicoobWebhook(req.body);

  } catch (error) {
    console.error('❌ Erro no webhook:', error);
    res.status(200).json({
      mensagem: "Notificação recebida"
    });
  }
});

// Função para processar notificações do Sicoob
const processSicoobWebhook = (payload) => {
  try {
    const io = getIo();

    // Verificar se é uma notificação de movimento com pix
    if (payload && payload.pix && Array.isArray(payload.pix)) {
      payload.pix.forEach((pix) => {
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
    } else {
      console.log('ℹ️ Webhook recebido com formato não esperado:', payload);
    }
  } catch (error) {
    console.error('❌ Erro ao processar notificação do Sicoob:', error);
  }
};

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

// Adicione esta função no seu servidor principal
const checkSicoobConnectivity = async () => {
  try {
    console.log('🔍 Testando conectividade com a API Sicoob...');

    // Tentativa simples de obter token
    const accessToken = await getSicoobAccessToken();

    if (accessToken) {
      console.log('✅ Conectividade com Sicoob: OK');
      return true;
    } else {
      console.log('❌ Falha na conectividade com Sicoob');
      return false;
    }
  } catch (error) {
    console.error('❌ Erro de conectividade com Sicoob:');
    console.error(error.message);

    // Verificar se é problema de certificado
    if (error.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
      error.code === 'CERT_HAS_EXPIRED' ||
      error.message.includes('certificate')) {
      console.error('⚠️  Problema possivelmente relacionado a certificados SSL');
      console.error('Verifique os caminhos dos certificados e senhas no .env');
    }

    return false;
  }
};

// Rota para testar conexão com Sicoob
app.get('/api/test-sicoob-connection', async (req, res) => {
  try {
    console.log('🔍 Testando conectividade com a API Sicoob...');

    // Tentativa simples de obter token
    const accessToken = await getSicoobAccessToken();

    if (accessToken) {
      res.json({
        success: true,
        message: 'Conectividade com Sicoob: OK',
        token: accessToken.substring(0, 50) + '...' // Mostrar apenas parte do token
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Falha na conectividade com Sicoob'
      });
    }
  } catch (error) {
    console.error('❌ Erro de conectividade com Sicoob:', error.message);
    res.status(500).json({
      success: false,
      message: error.message,
      details: error.response?.data
    });
  }
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

    console.log('📝 Tentando registrar webhook Sicoob Sandbox:', webhookUrl);

    const result = await registerWebhook(webhookUrl);

    if (result.success) {
      console.log('✅ Webhook Sicoob registrado com sucesso no sandbox:', result);
    } else {
      console.log('ℹ️  ', result.message);
      console.log('ℹ️  URL para registro manual:', webhookUrl);
      console.log('ℹ️  Tipo de movimento: 7 (Pagamento/Baixa operacional)');
      console.log('ℹ️  Período: 1 (Movimento atual D0)');
    }

  } catch (error) {
    console.error('❌ Erro ao registrar webhook Sicoob:', error.message);
  }
};
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


// Rota para testar conexão com Sicoob produção
app.get('/api/test-producao', async (req, res) => {
  try {
    console.log('🔍 Testando conexão com Sicoob produção...');
    
    const accessToken = await getSicoobAccessToken();
    const clientId = process.env.SICOOB_CLIENT_ID;
    
    // Testar endpoint de cobrança
    const response = await axios.get(
      `${process.env.SICOOB_API_BASE_URL}/cob/TESTE123`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Client-Id': clientId
        },
        httpsAgent: await createHttpsAgent() // Função que cria o agente HTTPS
      }
    );
    
    res.json({ 
      success: true, 
      message: 'Conexão com Sicoob produção: OK',
      status: response.status 
    });
  } catch (error) {
    console.error('❌ Erro ao conectar com Sicoob produção:', error.message);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      details: 'Verifique certificados e credenciais de produção'
    });
  }
});

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