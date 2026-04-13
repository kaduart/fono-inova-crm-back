// tests/setup.js
// 🔧 Setup global para testes Jest

import dotenv from 'dotenv';
import mongoose from 'mongoose';

// Carregar variáveis de ambiente
dotenv.config({ path: '.env.test' });

// Mock de console para testes limpos
global.console = {
  ...console,
  // Comentar para debug:
  // log: jest.fn(),
  // debug: jest.fn(),
  // info: jest.fn(),
  // warn: jest.fn(),
  // error: jest.fn(),
};

// Setup antes de todos os testes
beforeAll(async () => {
  // Conectar ao MongoDB de teste
  const mongoUri = process.env.MONGODB_URI_TEST || 'mongodb://localhost:27017/fono_inova_test';
  
  await mongoose.connect(mongoUri);
  console.log(`🧪 Testes conectados a: ${mongoUri}`);
});

// Cleanup após todos os testes
afterAll(async () => {
  await mongoose.connection.close();
  console.log('🧪 Conexão de testes fechada');
});

// Limpar dados entre testes (opcional)
afterEach(async () => {
  // Se necessário, limpar coleções específicas
  // await Appointment.deleteMany({ correlationId: /test_/ });
});
