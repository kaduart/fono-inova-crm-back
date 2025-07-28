import cookieParser from 'cookie-parser';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import './models/Doctor.js';
import './models/Package.js';
import './models/Patient.js';
import './models/Payment.js';
import './models/Session.js';
import './models/Specialty.js';
import './models/User.js';
import adminRoutes from './routes/admin.js';
import appointmentRoutes from './routes/appointment.js';
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
//import { initializeSocket } from './socket';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, './.env') });
const app = express();
const PORT = process.env.PORT || 5000;


const allowedOrigins = [
  'https://fono-inova-combr.vercel.app',
  'https://fono-inova-com-8qx8n8po3-kadu-arts-projects.vercel.app',
  'http://localhost:3000',
  'http://167.234.249.6:3000'
];

// Middleware CORS melhorado
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }
  }
  next();
});

app.use(express.json());
app.use(cookieParser());
app.options('*', cors());
/* 
descomentar qdo ativar o websocket do sicob
const server = http.createServer(app);
 initializeSocket(server); */

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch((err) => console.error('Could not connect to MongoDB', err));


// Routes
app.use('/api/signup', signupRoutes);
app.use('/api/login', loginRoutes);

app.use('/api/admin', adminRoutes);
app.use('/api/doctor', doctorRoutes);
app.use('/api/patients', patientRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/evolutions', evolutionRoutes);
app.use('/api/leads', leadsRouter);
app.use('/api/packages', PackageRoutes);
app.use('/api/payments', PaymentRoutes);
app.use('/api/users', UserRoutes);

app.use('/api/specialties', specialtyRouter);

app.use((err, req, res, next) => {
  console.error(err.stack);
  //res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  // res.header('Access-Control-Allow-Credentials', 'true');
  res.status(500).json({ error: 'Something broke!' });
});

if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.join(__dirname, "../frontend/build")));

  app.get("*", (req, res) => {
    // Headers CORS para produção
    res.header('Access-Control-Allow-Origin', 'https://fono-inova-combr.vercel.app');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.sendFile(path.join(__dirname, "../frontend/build/index.html"));
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});
