// ✅ CORREÇÃO: SessionValue zerado em appointments
// Corrige appointments com sessionValue = 0 ou valores muito baixos
//
// Uso: DRY_RUN=false node corrigir-sessionValue-zero.js

import mongoose from 'mongoose';
import dotenv from 'dotenv';

import Appointment from '../models/Appointment.js';
import Patient from '../models/Patient.js';
import Package from '../models/Package.js';

dotenv.config();

const DRY_RUN = process.env.DRY_RUN !== 'false';
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';

// Valores padrão
const VALOR_AVALIACAO_PADRAO = 200;
const VALOR_SESSAO_PADRAO = 150;
const VALOR_MINIMO_VALIDO = 1; // Abaixo disso é considerado erro

async function corrigir() {
    console.log('========================================');
    console.log('✅ CORREÇÃO: SessionValue Zerado');
    console.log(`📋 MODO: ${DRY_RUN ? 'DRY RUN' : 'EXECUÇÃO REAL'}`);
    console.log('========================================\n');

    await mongoose.connect(MONGO_URI);
    console.log('✅ Conectado ao MongoDB\n');

    const stats = {
        analisados: 0,
        corrigidos: 0,
        pacotes: 0,
        avaliacoes: 0,
        sessoes: 0,
        jaCorretos: 0,
        erros: []
    };

    // Buscar appointments com valor muito baixo ou zero
    const appointments = await Appointment.find({
        $or: [
            { sessionValue: { $exists: false } },
            { sessionValue: null },
            { sessionValue: 0 },
            { sessionValue: { $lt: VALOR_MINIMO_VALIDO } }
        ],
        isDeleted: { $ne: true }
    }).sort({ date: -1 }).limit(500);

    console.log(`📦 ${appointments.length} appointments com valor zerado/baixo\n`);

    for (const apt of appointments) {
        try {
            stats.analisados++;
            const aptId = apt._id.toString();
            const valorAtual = apt.sessionValue || 0;

            // Buscar paciente
            const patient = await Patient.findById(apt.patient);
            
            // Determinar valor correto
            let valorCorreto = 0;
            let tipo = '';

            // Se é sessão de pacote
            if (apt.isPackage || apt.package) {
                const packageInfo = await Package.findById(apt.package);
                if (packageInfo && packageInfo.sessionValue) {
                    valorCorreto = packageInfo.sessionValue;
                } else if (packageInfo && packageInfo.totalValue && packageInfo.totalSessions) {
                    valorCorreto = packageInfo.totalValue / packageInfo.totalSessions;
                } else {
                    valorCorreto = patient?.sessionValue || VALOR_SESSAO_PADRAO;
                }
                tipo = 'pacote';
                stats.pacotes++;
            }
            // Se é avaliação
            else if (apt.serviceType === 'evaluation' || apt.service === 'evaluation') {
                valorCorreto = patient?.evaluationValue || patient?.sessionValue || VALOR_AVALIACAO_PADRAO;
                tipo = 'avaliação';
                stats.avaliacoes++;
            }
            // Sessão regular
            else {
                valorCorreto = patient?.sessionValue || VALOR_SESSAO_PADRAO;
                tipo = 'sessão';
                stats.sessoes++;
            }

            // Arredondar para 2 casas decimais
            valorCorreto = Math.round(valorCorreto * 100) / 100;

            // Se o valor atual já está correto (ou próximo)
            if (Math.abs(valorAtual - valorCorreto) < 1) {
                stats.jaCorretos++;
                continue;
            }

            console.log(`📝 ${aptId}`);
            console.log(`   Paciente: ${patient?.fullName || 'N/D'}`);
            console.log(`   Data: ${apt.date?.toISOString().split('T')[0]} ${apt.time || ''}`);
            console.log(`   Tipo: ${tipo}`);
            console.log(`   Valor atual: R$ ${valorAtual}`);
            console.log(`   Valor correto: R$ ${valorCorreto}`);

            if (!DRY_RUN) {
                apt.sessionValue = valorCorreto;
                
                // Adicionar histórico
                apt.history = apt.history || [];
                apt.history.push({
                    action: 'sessionValue_correction',
                    previousValue: valorAtual,
                    newValue: valorCorreto,
                    reason: `Correção automática - valor ${tipo}`,
                    timestamp: new Date()
                });

                await apt.save({ validateBeforeSave: false });
                console.log('   ✅ Corrigido!\n');
                stats.corrigidos++;
            } else {
                console.log('   [DRY RUN - não salvo]\n');
                stats.corrigidos++;
            }

        } catch (error) {
            console.error(`❌ Erro no appointment ${apt._id}:`, error.message);
            stats.erros.push({ appointmentId: apt._id, error: error.message });
        }
    }

    // RELATÓRIO
    console.log('\n========================================');
    console.log('📊 RELATÓRIO');
    console.log('========================================');
    console.log(`Total analisados: ${stats.analisados}`);
    console.log(`Corrigidos: ${stats.corrigidos}`);
    console.log(`  → Pacotes: ${stats.pacotes}`);
    console.log(`  → Avaliações: ${stats.avaliacoes}`);
    console.log(`  → Sessões: ${stats.sessoes}`);
    console.log(`Já corretos: ${stats.jaCorretos}`);
    console.log(`Erros: ${stats.erros.length}`);

    if (DRY_RUN) {
        console.log('\n⚠️  DRY RUN - Nenhuma alteração foi salva!');
        console.log('   Para executar: DRY_RUN=false node corrigir-sessionValue-zero.js');
    } else {
        console.log('\n💾 Correções salvas!');
    }

    await mongoose.disconnect();
    console.log('\n👋 Done!');
    process.exit(0);
}

corrigir().catch(err => {
    console.error('💥 Erro:', err);
    process.exit(1);
});
