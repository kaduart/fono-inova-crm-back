// Script para corrigir/cancelar atendimentos pendentes "quebrados"
// Execute: node back/scripts/corrigir-atendimentos-pendentes.js
// 
// MODO DE USO:
// 1. Primeiro execute no modo DRY-RUN (padrão) para ver o que será alterado
// 2. Depois execute com --confirm para aplicar as mudanças
//
// OPÇÕES:
// --confirm          : Aplica as mudanças (padrão é só simular)
// --delete           : Deleta os pagamentos ao invés de cancelar
// --package-only     : Só processa pagamentos de pacote
// --orphan-only      : Só processa pagamentos órfãos (sem appointment)

import mongoose from 'mongoose';
import moment from 'moment-timezone';

const uri = process.env.MONGODB_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';
const TIMEZONE = 'America/Sao_Paulo';

const args = process.argv.slice(2);
const CONFIRM = args.includes('--confirm');
const DELETE_MODE = args.includes('--delete');
const PACKAGE_ONLY = args.includes('--package-only');
const ORPHAN_ONLY = args.includes('--orphan-only');

async function corrigirPendentes() {
    try {
        await mongoose.connect(uri);
        console.log('🔌 Conectado ao MongoDB\n');

        const Payment = mongoose.model('Payment', new mongoose.Schema({}, { strict: false }));
        const Appointment = mongoose.model('Appointment', new mongoose.Schema({}, { strict: false }));

        // Período: Abril/2026
        const targetDate = moment.tz('2026-04-06', TIMEZONE);
        const startOfMonth = targetDate.clone().startOf('month');
        const endOfMonth = targetDate.clone().endOf('month');

        console.log('📅 Período:', startOfMonth.format('DD/MM/YYYY'), 'até', endOfMonth.format('DD/MM/YYYY'));
        console.log('⚙️  MODO:', CONFIRM ? (DELETE_MODE ? '🗑️  DELETE' : '✅ CANCELAR') : '👁️  SIMULAÇÃO (dry-run)');
        console.log('🎯 FILTROS:', PACKAGE_ONLY ? 'Apenas PACOTES' : ORPHAN_ONLY ? 'Apenas ÓRFÃOS' : 'TODOS');
        console.log('=' .repeat(80));

        // Build do filtro
        const matchFilter = {
            status: 'pending',
            paymentDate: {
                $gte: startOfMonth.toDate(),
                $lte: endOfMonth.toDate()
            }
        };

        // Buscar pagamentos pendentes
        let pendentes = await Payment.find(matchFilter).sort({ paymentDate: 1 }).lean();

        // Aplicar filtros adicionais
        if (PACKAGE_ONLY) {
            pendentes = pendentes.filter(p => p.packageId || p.package);
        }

        if (ORPHAN_ONLY) {
            const orphans = [];
            for (const p of pendentes) {
                const hasAppointment = p.appointmentId || p.appointment 
                    ? await Appointment.exists({ _id: p.appointmentId || p.appointment })
                    : false;
                if (!hasAppointment) {
                    orphans.push(p);
                }
            }
            pendentes = orphans;
        }

        console.log(`\n🚨 Pagamentos a processar: ${pendentes.length}\n`);

        if (pendentes.length === 0) {
            console.log('✅ Nenhum pagamento pendente encontrado com os filtros atuais.');
            return;
        }

        let totalValor = 0;
        const idsParaProcessar = [];

        for (const p of pendentes) {
            totalValor += p.amount || 0;
            idsParaProcessar.push(p._id.toString());
            
            const appointment = p.appointmentId || p.appointment 
                ? await Appointment.findById(p.appointmentId || p.appointment).lean()
                : null;

            console.log(`📌 ${p._id} | R$ ${(p.amount || 0).toFixed(2)} | ${p.source || 'manual'} ${appointment ? '' : '(ÓRFÃO)'}`);
        }

        console.log('\n' + '='.repeat(80));
        console.log('💵 Valor total:', `R$ ${totalValor.toFixed(2)}`);
        console.log('📊 Quantidade:', pendentes.length, 'pagamentos');

        if (!CONFIRM) {
            console.log('\n⚠️  MODO SIMULAÇÃO - Nenhuma alteração foi feita!');
            console.log('💡 Para aplicar as mudanças, execute com: --confirm');
            if (!DELETE_MODE) {
                console.log('💡 Para DELETAR ao invés de cancelar, adicione: --delete');
            }
            return;
        }

        // CONFIRMADO - Aplicar mudanças
        console.log('\n🔄 Aplicando mudanças...');

        if (DELETE_MODE) {
            // Deletar fisicamente
            const result = await Payment.deleteMany({
                _id: { $in: idsParaProcessar }
            });
            console.log(`✅ ${result.deletedCount} pagamentos DELETADOS`);
        } else {
            // Marcar como cancelados
            const result = await Payment.updateMany(
                { _id: { $in: idsParaProcessar } },
                { 
                    $set: { 
                        status: 'canceled',
                        canceledAt: new Date(),
                        cancelReason: 'Correção manual - atendimentos quebrados'
                    }
                }
            );
            console.log(`✅ ${result.modifiedCount} pagamentos CANCELADOS`);
        }

        console.log('\n🎉 Concluído!');
        console.log('💡 O dashboard deve ser recalculado automaticamente.');
        console.log('🔄 Se necessário, acione o recálculo manual em: POST /api/v2/totals/recalculate');

    } catch (err) {
        console.error('❌ Erro:', err.message);
    } finally {
        await mongoose.disconnect();
        console.log('\n🔌 Desconectado do MongoDB');
    }
}

// Help
if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Uso: node corrigir-atendimentos-pendentes.js [opções]

Opções:
  --confirm       Aplica as mudanças (padrão é só simular)
  --delete        Deleta os pagamentos ao invés de cancelar
  --package-only  Só processa pagamentos de pacote
  --orphan-only   Só processa pagamentos órfãos (sem appointment)
  --help, -h      Mostra esta ajuda

Exemplos:
  # Simular cancelamento de todos
  node corrigir-atendimentos-pendentes.js

  # Cancelar todos os pagamentos pendentes
  node corrigir-atendimentos-pendentes.js --confirm

  # Deletar apenas pagamentos órfãos
  node corrigir-atendimentos-pendentes.js --orphan-only --delete --confirm

  # Cancelar apenas pagamentos de pacote
  node corrigir-atendimentos-pendentes.js --package-only --confirm
`);
    process.exit(0);
}

corrigirPendentes();
