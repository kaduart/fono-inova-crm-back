#!/usr/bin/env node
/**
 * 💰 CRIAR PAYMENTS DE CONVÊNIO - ABRIL 2026
 * Gera automaticamente payments para sessões de convênio
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Session from '../models/Session.js';
import Package from '../models/Package.js';
import Payment from '../models/Payment.js';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

const MES = '2026-04';

async function criarPayments() {
  try {
    console.log('🔗 Conectando...');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Conectado!\n');

    const startDate = new Date('2026-04-01T00:00:00-03:00');
    const endDate = new Date('2026-04-30T23:59:59-03:00');

    console.log('='.repeat(80));
    console.log(`💰 GERANDO PAYMENTS DE CONVÊNIO - ABRIL 2026`);
    console.log('='.repeat(80));

    // 1. Buscar sessões de convênio em abril
    const sessoes = await Session.find({
      date: { $gte: startDate, $lte: endDate },
      $or: [
        { paymentMethod: 'convenio' },
        { 'package.type': 'convenio' }
      ]
    }).populate('patient').populate('doctor').populate('package').lean();

    console.log(`\n📋 Total de sessões de convênio: ${sessoes.length}`);

    let criados = 0;
    let existentes = 0;

    for (const sessao of sessoes) {
      // Verificar se já existe payment para esta sessão
      const paymentExistente = await Payment.findOne({ session: sessao._id });
      if (paymentExistente) {
        existentes++;
        continue;
      }

      const pkg = sessao.package;
      if (!pkg || pkg.type !== 'convenio') {
        console.log(`   ⚠️  Sessão sem pacote de convênio: ${sessao._id}`);
        continue;
      }

      // Criar payment
      const paymentData = {
        patient: sessao.patient?._id,
        doctor: sessao.doctor?._id,
        serviceType: 'session',
        amount: pkg.insuranceGrossAmount || 0,
        package: pkg._id,
        session: sessao._id,
        kind: 'manual',
        status: 'pending',
        notes: `Sessão - Guia ${pkg.insuranceGuideNumber || 'N/A'}`,
        serviceDate: sessao.date,
        billingType: 'convenio',
        paymentMethod: 'convenio',
        insurance: {
          provider: pkg.insuranceProvider || pkg.insuranceCompany || 'convenio',
          authorizationCode: pkg.insuranceAuthorizationCode || null,
          guideNumber: pkg.insuranceGuideNumber || null,
          status: 'pending_billing',
          grossAmount: pkg.insuranceGrossAmount || 0,
          netAmount: pkg.insuranceNetAmount || pkg.insuranceGrossAmount || 0
        },
        paymentDate: sessao.date
      };

      await Payment.create(paymentData);
      criados++;
      
      if (criados % 10 === 0) {
        process.stdout.write(`\r   💰 Criados: ${criados}`);
      }
    }

    console.log(`\n\n✅ RESUMO:`);
    console.log(`   Payments criados: ${criados}`);
    console.log(`   Já existentes: ${existentes}`);
    console.log(`   Total processado: ${sessoes.length}`);

    // 3. Verificar totals
    const totalAbril = await Payment.countDocuments({
      billingType: 'convenio',
      paymentDate: { $gte: startDate, $lte: endDate }
    });
    console.log(`\n   Total de payments em abril/2026: ${totalAbril}`);

    await mongoose.disconnect();
    console.log('\n✅ Desconectado');
    
  } catch (error) {
    console.error('❌ Erro:', error);
    process.exit(1);
  }
}

// Instalar uuid se necessário
import { execSync } from 'child_process';
try {
  await import('uuid');
} catch {
  console.log('📦 Instalando uuid...');
  execSync('npm install uuid --save', { cwd: '/home/user/projetos/crm/back' });
}

criarPayments();
