// 1️⃣ CORRIGIR SESSION.VALUE (Fonte de Verdade)
// Preenche session.value com base nas fontes corretas
//
// ORDEM DE PRIORIDADE:
// 1. Package.sessionValue (se é sessão de pacote)
// 2. Payment.amount (se foi pago)
// 3. Appointment.sessionValue (fallback)
// 4. Default (evaluation=200, session=150)

import mongoose from 'mongoose';
import dotenv from 'dotenv';

import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import Package from '../models/Package.js';
import Payment from '../models/Payment.js';

dotenv.config();

const DRY_RUN = process.env.DRY_RUN !== 'false';
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';

async function fixSessionValue() {
  console.log('========================================');
  console.log('1️⃣ FIX SESSION.VALUE - Fonte de Verdade');
  console.log(`MODO: ${DRY_RUN ? 'DRY RUN' : 'EXECUÇÃO REAL'}`);
  console.log('========================================\n');

  await mongoose.connect(MONGO_URI);
  console.log('✅ Conectado ao MongoDB\n');

  const stats = {
    analisadas: 0,
    corrigidas: 0,
    doPackage: 0,
    doPayment: 0,
    doAppointment: 0,
    fallback: 0,
    divergencias: [],
    erros: []
  };

  // Buscar todas as sessions que precisam de valor
  const sessions = await Session.find({
    $or: [
      { value: { $exists: false } },
      { value: null },
      { value: 0 },
      { value: { $lte: 0.1 } } // Lixo de teste
    ],
    isDeleted: { $ne: true }
  }).limit(1000);

  console.log(`📦 ${sessions.length} sessions sem valor válido\n`);

  for (const session of sessions) {
    try {
      stats.analisadas++;
      
      // Buscar appointment relacionado
      const appointment = await Appointment.findOne({
        $or: [
          { _id: session.appointmentId },
          { session: session._id }
        ]
      });

      let newValue = null;
      let source = '';

      // ========================================
      // 1️⃣ PRIORIDADE 1: PACKAGE
      // ========================================
      if (appointment?.package) {
        const pkg = await Package.findById(appointment.package);
        if (pkg?.sessionValue > 0) {
          newValue = pkg.sessionValue;
          source = 'package';
          stats.doPackage++;
        }
      }

      // ========================================
      // 2️⃣ PRIORIDADE 2: PAYMENT (Valor Real)
      // ========================================
      if (!newValue) {
        const payment = await Payment.findOne({
          $or: [
            { sessionId: session._id },
            { appointmentId: appointment?._id }
          ]
        });
        
        if (payment?.amount > 0) {
          // ⚠️ Verificar divergência com package
          if (appointment?.package) {
            const pkg = await Package.findById(appointment.package);
            if (pkg?.sessionValue > 0 && Math.abs(pkg.sessionValue - payment.amount) > 1) {
              stats.divergencias.push({
                sessionId: session._id,
                packageValue: pkg.sessionValue,
                paymentValue: payment.amount,
                mensagem: '⚠️ DIVERGÊNCIA: Package vs Payment'
              });
              // Em caso de divergência, usar package (preço correto)
              newValue = pkg.sessionValue;
              source = 'package (divergência)';
            } else {
              newValue = payment.amount;
              source = 'payment';
              stats.doPayment++;
            }
          } else {
            newValue = payment.amount;
            source = 'payment';
            stats.doPayment++;
          }
        }
      }

      // ========================================
      // 3️⃣ PRIORIDADE 3: APPOINTMENT (Legado)
      // ========================================
      if (!newValue && appointment?.sessionValue > 1) {
        newValue = appointment.sessionValue;
        source = 'appointment';
        stats.doAppointment++;
      }

      // ========================================
      // 4️⃣ FALLBACK CONTROLADO
      // ========================================
      if (!newValue) {
        if (appointment?.service === 'evaluation' || 
            appointment?.serviceType === 'evaluation') {
          newValue = 200;
        } else {
          newValue = 150;
        }
        source = 'fallback';
        stats.fallback++;
      }

      // Ignorar valores inválidos
      if (newValue <= 0.1) {
        console.log(`❌ Pulando ${session._id}: valor inválido (${newValue})`);
        continue;
      }

      console.log(`${DRY_RUN ? '[DRY]' : '[CORRIGIR]'} ${session._id}`);
      console.log(`    Status: ${session.status}`);
      console.log(`    Valor: ${session.value || 0} → ${newValue}`);
      console.log(`    Fonte: ${source}`);
      if (appointment?.package) console.log(`    Package: ${appointment.package}`);
      console.log('');

      if (!DRY_RUN) {
        await Session.updateOne(
          { _id: session._id },
          {
            $set: {
              value: newValue,
              valueSource: source,
              valueUpdatedAt: new Date()
            }
          }
        );
        stats.corrigidas++;
      } else {
        stats.corrigidas++; // Contar mesmo em DRY_RUN para preview
      }

    } catch (error) {
      console.error(`❌ Erro na session ${session._id}:`, error.message);
      stats.erros.push({ sessionId: session._id, error: error.message });
    }
  }

  // RELATÓRIO
  console.log('\n========================================');
  console.log('📊 RELATÓRIO');
  console.log('========================================');
  console.log(`Sessions analisadas: ${stats.analisadas}`);
  console.log(`Corrigidas: ${stats.corrigidas}`);
  console.log(`  → De Package: ${stats.doPackage}`);
  console.log(`  → De Payment: ${stats.doPayment}`);
  console.log(`  → De Appointment: ${stats.doAppointment}`);
  console.log(`  → Fallback: ${stats.fallback}`);
  console.log(`Divergências: ${stats.divergencias.length}`);
  console.log(`Erros: ${stats.erros.length}`);

  if (stats.divergencias.length > 0) {
    console.log('\n⚠️ DIVERGÊNCIAS ENCONTRADAS:');
    stats.divergencias.forEach(d => {
      console.log(`   ${d.sessionId}: Package=${d.packageValue} vs Payment=${d.paymentValue}`);
    });
  }

  if (DRY_RUN) {
    console.log('\n⚠️ DRY RUN - Nenhuma alteração salva!');
    console.log('Para executar: DRY_RUN=false node 01-fix-session-value.js');
  } else {
    console.log('\n✅ Correções salvas!');
  }

  await mongoose.disconnect();
  console.log('\n👋 Done!');
  process.exit(0);
}

fixSessionValue().catch(err => {
  console.error('💥 Erro:', err);
  process.exit(1);
});
