#!/usr/bin/env node
/**
 * 🔍 ANÁLISE CONVÊNIOS - ABRIL 2026
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';
import Package from '../models/Package.js';

dotenv.config();

const MES = '2026-04';

async function analisar() {
  try {
    console.log('🔗 Conectando...');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Conectado!\n');

    const startDate = new Date('2026-04-01T00:00:00-03:00');
    const endDate = new Date('2026-04-30T23:59:59-03:00');

    console.log('='.repeat(80));
    console.log(`🏥 CONVÊNIOS - ABRIL 2026`);
    console.log('='.repeat(80));

    // 1. SESSÕES DE CONVÊNIO EM ABRIL
    console.log('\n📋 1. SESSÕES DE CONVÊNIO (Sessions)');
    console.log('-'.repeat(80));
    
    const sessoesConvenio = await Session.find({
      date: { $gte: startDate, $lte: endDate },
      $or: [
        { paymentMethod: 'convenio' },
        { 'package.type': 'convenio' }
      ]
    }).populate('patient', 'fullName').populate('doctor', 'fullName').populate('package').lean();

    console.log(`   Total: ${sessoesConvenio.length} sessões de convênio`);
    
    let totalAReceber = 0;
    let totalRecebido = 0;
    
    sessoesConvenio.forEach((s, i) => {
      const valor = s.sessionValue || s.package?.insuranceGrossAmount || 0;
      const isPago = s.isPaid || s.paymentStatus === 'paid';
      
      if (isPago) totalRecebido += valor;
      else totalAReceber += valor;

      console.log(`\n   ${i+1}. ${s.patient?.fullName} - ${new Date(s.date).toLocaleDateString('pt-BR')}`);
      console.log(`       Status: ${s.status} | Pago: ${isPago ? '✅' : '❌'}`);
      console.log(`       Valor: R$ ${valor}`);
      console.log(`       Convênio: ${s.package?.insuranceProvider || 'N/A'}`);
    });

    // 2. PAGAMENTOS DE CONVÊNIO
    console.log('\n\n📋 2. PAGAMENTOS DE CONVÊNIO (Payments)');
    console.log('-'.repeat(80));
    
    const paymentsConvenio = await Payment.find({
      billingType: 'convenio',
      $or: [
        { paymentDate: { $gte: startDate, $lte: endDate } },
        { serviceDate: { $gte: startDate, $lte: endDate } }
      ]
    }).populate('patient', 'fullName').lean();

    console.log(`   Total: ${paymentsConvenio.length} pagamentos`);
    
    paymentsConvenio.forEach((p, i) => {
      console.log(`\n   ${i+1}. ${p.patient?.fullName} - R$ ${p.amount}`);
      console.log(`       Status: ${p.status}`);
      console.log(`       Convênio: ${p.insurance?.provider || 'N/A'}`);
      console.log(`       Guia: ${p.insurance?.guideNumber || 'N/A'}`);
    });

    // 3. PACOTES DE CONVÊNIO COM SESSÕES EM ABRIL
    console.log('\n\n📋 3. PACOTES DE CONVÊNIO');
    console.log('-'.repeat(80));
    
    const pacotesConvenio = await Package.find({
      type: 'convenio',
      'sessions.date': { $gte: startDate, $lte: endDate }
    }).populate('patient', 'fullName').lean();

    console.log(`   Total: ${pacotesConvenio.length} pacotes`);
    
    pacotesConvenio.forEach((pkg, i) => {
      console.log(`\n   ${i+1}. ${pkg.patient?.fullName}`);
      console.log(`       Convênio: ${pkg.insuranceProvider}`);
      console.log(`       Guia: ${pkg.insuranceGuideNumber || 'N/A'}`);
      console.log(`       Valor Bruto: R$ ${pkg.insuranceGrossAmount}`);
      console.log(`       Sessões: ${pkg.sessionsDone}/${pkg.totalSessions}`);
    });

    // 4. RESUMO
    console.log('\n\n' + '='.repeat(80));
    console.log('📊 RESUMO FINANCEIRO CONVÊNIOS - ABRIL 2026');
    console.log('='.repeat(80));
    console.log(`   Sessões realizadas: ${sessoesConvenio.length}`);
    console.log(`   Total a receber: R$ ${totalAReceber.toFixed(2)}`);
    console.log(`   Total recebido: R$ ${totalRecebido.toFixed(2)}`);
    console.log(`   Total: R$ ${(totalAReceber + totalRecebido).toFixed(2)}`);

    await mongoose.disconnect();
    console.log('\n✅ Desconectado');
    
  } catch (error) {
    console.error('❌ Erro:', error);
    process.exit(1);
  }
}

analisar();
