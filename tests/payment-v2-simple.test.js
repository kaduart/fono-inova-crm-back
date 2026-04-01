#!/usr/bin/env node
/**
 * Teste Simples - Payment V2
 * Testa se o patch está funcionando corretamente
 */

import mongoose from 'mongoose';
import '../config/db.js'; // Conecta ao MongoDB

import Patient from '../models/Patient.js';
import PatientsView from '../models/PatientsView.js';
import Payment from '../models/Payment.js';
import { publishEvent } from '../infrastructure/events/eventPublisher.js';
import { buildPatientView } from '../domains/clinical/services/patientProjectionService.js';

console.log('🚀 Teste Payment V2 - Iniciando...\n');

async function test() {
  try {
    // Aguarda conexão
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // 1. Criar paciente de teste
    console.log('1️⃣  Criando paciente de teste...');
    const patient = await Patient.create({
      fullName: 'TEST_PAYMENT_Simple',
      dateOfBirth: new Date('1990-01-01'),
      phone: '11999999999'
    });
    console.log(`   ✅ Paciente: ${patient._id}`);
    
    // 2. Criar pagamento
    console.log('\n2️⃣  Criando pagamento de R$ 150,00...');
    const payment = await Payment.create({
      patient: patient._id,
      amount: 150.00,
      paymentMethod: 'pix',
      status: 'completed',
      paidAt: new Date()
    });
    console.log(`   ✅ Pagamento: ${payment._id}`);
    
    // 3. Emitir evento (simula o que o patch faz)
    console.log('\n3️⃣  Emitindo evento PAYMENT_RECEIVED...');
    await publishEvent('PAYMENT_RECEIVED', {
      paymentId: payment._id.toString(),
      patientId: patient._id.toString(),
      amount: 150.00,
      paymentMethod: 'pix',
      receivedAt: new Date().toISOString()
    });
    console.log('   ✅ Evento emitido');
    
    // 4. Rebuild view
    console.log('\n4️⃣  Rebuild PatientsView...');
    await buildPatientView(patient._id.toString(), { 
      correlationId: 'test',
      force: true 
    });
    console.log('   ✅ View reconstruída');
    
    // 5. Verificar
    console.log('\n5️⃣  Verificando PatientsView...');
    const view = await PatientsView.findOne({ patientId: patient._id }).lean();
    
    if (!view) {
      console.log('   ❌ View não encontrada');
      process.exit(1);
    }
    
    console.log(`   totalRevenue: R$ ${view.stats?.totalRevenue || 0}`);
    
    if (view.stats?.totalRevenue === 150) {
      console.log('\n✅ TESTE PASSOU!');
      console.log('   PatientsView atualizou corretamente após pagamento.');
    } else {
      console.log('\n❌ TESTE FALHOU!');
      console.log(`   Esperado: R$ 150,00`);
      console.log(`   Recebido: R$ ${view.stats?.totalRevenue || 0}`);
    }
    
    // Cleanup
    console.log('\n🧹 Limpando dados de teste...');
    await Patient.findByIdAndDelete(patient._id);
    await PatientsView.deleteOne({ patientId: patient._id });
    await Payment.findByIdAndDelete(payment._id);
    console.log('   ✅ Dados limpos');
    
    process.exit(0);
    
  } catch (error) {
    console.error('\n💥 Erro:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

test();
