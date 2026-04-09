// 🔄 RESTAURAR STATUS APÓS BATCH RESET
// Reverte appointments que foram alterados de completed/canceled para scheduled
// pelo script de reset em massa
//
// Uso: DRY_RUN=false node restaurar-status-pos-reset.js

import mongoose from 'mongoose';
import dotenv from 'dotenv';

import Appointment from '../models/Appointment.js';

dotenv.config();

const DRY_RUN = process.env.DRY_RUN !== 'false';
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';

async function restaurarStatus() {
    console.log('========================================');
    console.log('🔄 RESTAURAR STATUS PÓS BATCH RESET');
    console.log(`📋 MODO: ${DRY_RUN ? 'DRY RUN' : 'EXECUÇÃO REAL'}`);
    console.log('========================================\n');

    await mongoose.connect(MONGO_URI);
    console.log('✅ Conectado ao MongoDB\n');

    const stats = {
        analisados: 0,
        restauradosCompleted: 0,
        restauradosCanceled: 0,
        semHistorico: 0,
        agendadoCorreto: 0,
        erros: []
    };

    // Buscar appointments de 2026 que estão como scheduled
    const appointments = await Appointment.find({
        operationalStatus: 'scheduled',
        date: {
            $gte: new Date('2026-01-01'),
            $lte: new Date('2026-12-31')
        },
        isDeleted: { $ne: true }
    }).sort({ date: -1 });

    console.log(`📦 ${appointments.length} appointments "scheduled" em 2026\n`);

    for (const apt of appointments) {
        try {
            stats.analisados++;
            const aptId = apt._id.toString();
            
            // Verificar histórico
            if (!apt.history || apt.history.length === 0) {
                stats.semHistorico++;
                continue;
            }

            // Procurar por qualquer alteração suspeita para scheduled
            // Prioridade: batch_reset, depois manual_reset, depois qualquer coisa que venha de processing_complete
            let resetEntry = null;
            let resetIndex = -1;
            
            // Procurar do mais recente para o mais antigo
            for (let i = apt.history.length - 1; i >= 0; i--) {
                const h = apt.history[i];
                // Batch reset
                if (h.action === 'batch_reset' || h.context?.includes('Reset em massa')) {
                    resetEntry = h;
                    resetIndex = i;
                    break;
                }
                // Manual reset
                if (h.action?.includes('reset') || h.action?.includes('retry')) {
                    resetEntry = h;
                    resetIndex = i;
                    break;
                }
                // Alteração para scheduled vindo de processing_complete
                if (h.newStatus === 'scheduled' && h.previousStatus === 'processing_complete') {
                    resetEntry = h;
                    resetIndex = i;
                    break;
                }
            }

            if (!resetEntry) {
                // Verificar se tem alguma entrada que indique completed/canceled antes
                const teveCompleted = apt.history.some(h => 
                    h.newStatus === 'completed' || h.previousStatus === 'completed'
                );
                const teveCanceled = apt.history.some(h => 
                    h.newStatus === 'canceled' || h.previousStatus === 'canceled'
                );
                
                if (!teveCompleted && !teveCanceled) {
                    stats.agendadoCorreto++;
                    continue;
                }
                
                // Se tem indício de completed/canceled no histórico, usar o último status válido
                resetIndex = apt.history.length; // usar última entrada
            }

            // Encontrar o status ANTES do reset (procurar backwards)
            let statusAnterior = null;
            const startIndex = resetIndex >= 0 ? resetIndex - 1 : apt.history.length - 1;
            
            for (let i = startIndex; i >= 0; i--) {
                const entry = apt.history[i];
                // Ignorar status de processamento
                if (entry.newStatus && !['processing_complete', 'processing_cancel', 'processing_create'].includes(entry.newStatus)) {
                    statusAnterior = entry.newStatus;
                    break;
                }
                if (entry.previousStatus && !['processing_complete', 'processing_cancel', 'processing_create'].includes(entry.previousStatus)) {
                    statusAnterior = entry.previousStatus;
                    break;
                }
            }

            // Se não achou, tentar pelo previousStatus do reset entry
            if (!statusAnterior && resetEntry?.previousStatus) {
                statusAnterior = resetEntry.previousStatus;
            }

            // Se ainda não achou, procurar no histórico inteiro se já foi completed
            if (!statusAnterior) {
                const teveCompleted = apt.history.some(h => 
                    h.newStatus === 'completed' || h.previousStatus === 'completed'
                );
                if (teveCompleted) {
                    statusAnterior = 'completed';
                }
            }

            // Validar se o status anterior faz sentido restaurar
            const statusValidos = ['completed', 'canceled', 'paid', 'missed', 'confirmed'];
            if (!statusAnterior || !statusValidos.includes(statusAnterior)) {
                stats.agendadoCorreto++;
                continue;
            }

            // Mapear status para operationalStatus válido
            let novoStatus = statusAnterior;
            if (statusAnterior === 'paid') novoStatus = 'completed';
            if (statusAnterior === 'confirmed') novoStatus = 'scheduled'; // confirmed → scheduled é ok

            // Se o status anterior é scheduled, não precisa mudar
            if (novoStatus === 'scheduled') {
                stats.agendadoCorreto++;
                continue;
            }

            console.log(`📝 ${aptId}`);
            console.log(`   Paciente: ${apt.patient?.toString() || 'N/D'}`);
            console.log(`   Data: ${apt.date?.toISOString().split('T')[0]} ${apt.time || ''}`);
            console.log(`   Status atual: scheduled`);
            console.log(`   Status antes do reset: ${statusAnterior}`);
            console.log(`   → Restaurar para: ${novoStatus}`);
            console.log(`   Data do reset: ${resetEntry?.timestamp ? new Date(resetEntry.timestamp).toLocaleString('pt-BR') : 'N/D (inferido do histórico)'}`);

            if (!DRY_RUN) {
                // Restaurar status
                apt.operationalStatus = novoStatus;
                
                // Adicionar ao histórico
                apt.history.push({
                    action: 'status_restored_after_reset',
                    previousStatus: 'scheduled',
                    newStatus: novoStatus,
                    originalStatusBeforeReset: statusAnterior,
                    resetTimestamp: resetEntry ? resetEntry.timestamp : null,
                    reason: 'Restauração automática após batch_reset',
                    timestamp: new Date()
                });

                await apt.save({ validateBeforeSave: false });
                console.log('   ✅ Restaurado!\n');
            } else {
                console.log('   [DRY RUN - não salvo]\n');
            }

            if (novoStatus === 'completed') stats.restauradosCompleted++;
            if (novoStatus === 'canceled') stats.restauradosCanceled++;

        } catch (error) {
            console.error(`❌ Erro no appointment ${apt._id}:`, error.message);
            stats.erros.push({ appointmentId: apt._id, error: error.message });
        }
    }

    // Relatório
    console.log('\n========================================');
    console.log('📊 RELATÓRIO');
    console.log('========================================');
    console.log(`Total analisados: ${stats.analisados}`);
    console.log(`Restaurados para COMPLETED: ${stats.restauradosCompleted}`);
    console.log(`Restaurados para CANCELED: ${stats.restauradosCanceled}`);
    console.log(`Agendado correto (não alterar): ${stats.agendadoCorreto}`);
    console.log(`Sem histórico: ${stats.semHistorico}`);
    console.log(`Erros: ${stats.erros.length}`);

    if (DRY_RUN) {
        console.log('\n⚠️  DRY RUN - Nenhuma alteração foi salva!');
        console.log('   Para executar: DRY_RUN=false node restaurar-status-pos-reset.js');
    } else {
        console.log('\n💾 Restaurações salvas!');
    }

    await mongoose.disconnect();
    console.log('\n👋 Done!');
    process.exit(0);
}

restaurarStatus().catch(err => {
    console.error('💥 Erro:', err);
    process.exit(1);
});
