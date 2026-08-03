#!/usr/bin/env node
/**
 * rebuild-payments-view.js
 *
 * Reconstroi a coleção payments_view a partir dos Payment atuais.
 * Executa em produção apenas após backup.
 */

import mongoose from 'mongoose';
import '../models/index.js';
import { rebuildPaymentsProjection } from '../projections/paymentsProjection.js';

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error('❌ MONGODB_URI ou MONGO_URI devem estar configurados');
  process.exit(1);
}

async function main() {
  console.log('🔌 Conectando ao MongoDB...');
  await mongoose.connect(MONGO_URI);
  console.log('✅ Conectado');

  try {
    console.log('🚀 Iniciando rebuild da PaymentsView...');
    const result = await rebuildPaymentsProjection();
    console.log('\n✅ Rebuild finalizado:', result);
  } catch (error) {
    console.error('❌ Erro no rebuild:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Desconectado');
  }
}

main();
