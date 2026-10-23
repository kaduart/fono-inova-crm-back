// tests/setup.js
// 🔧 Setup global para testes Jest
//
// ⚠️ TRAVA DE SEGURANÇA (aplicada em 2026-10-20)
// Incidente real: em 2026-10-20 o banco de produção (fono_inova_prod, no Atlas) foi esvaziado.
// Causa: suítes de teste que chamam mongoose.connect(process.env.MONGO_URI) sem isolamento —
// quando o .env de produção está carregado, MONGO_URI aponta para o Atlas real, e os
// `deleteMany({})` / `dropDatabase()` dessas suítes rodam contra produção.
// Já havia acontecido antes (ver tests/fiscal/_guardAgainstProductionDb.js, 2026-09-11).
//
// A trava abaixo é a mesma usada no módulo fiscal: ALLOWLIST de host. Só é permitido conectar
// se TODOS os hosts da URI forem loopback (127.0.0.1/localhost/::1). Qualquer Atlas, IP interno
// ou host desconhecido é recusado incondicionalmente. Não existe variável que libere.

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { assertLoopbackOnlyDatabase } from './fiscal/_guardAgainstProductionDb.js';

// Carregar variáveis de ambiente de teste.
// Importante: se .env.test não existir, NÃO caia para o .env de produção.
dotenv.config({ path: '.env.test' });

const DB_PADRAO_LOCAL = 'mongodb://127.0.0.1:27017/fono_inova_test';

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
  // Conectar ao MongoDB de teste.
  // NUNCA use MONGO_URI/MONGODB_URI (produção) como fallback aqui.
  const mongoUri = process.env.MONGODB_URI_TEST || DB_PADRAO_LOCAL;

  // Trava: recusa qualquer URI que não seja loopback (protege produção)
  try {
    assertLoopbackOnlyDatabase(mongoUri);
  } catch (err) {
    throw new Error(
      `[tests/setup.js] Conexão de teste bloqueada: ${err.message}\n` +
      `Defina MONGODB_URI_TEST para um banco local ou use mongodb-memory-server.`
    );
  }

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
