#!/usr/bin/env node
/**
 * Diagnóstico Caixa - Dias 01 e 02/04/2026
 */

import mongoose from 'mongoose';
import Payment from '../models/Payment.js';

async function diagnostico() {
    try {
        const uri = 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development?retryWrites=true&w=majority';
        await mongoose.connect(uri);
        console.log('✅ Conectado\n');

        for (const data of ['2026-04-01', '2026-04-02']) {
            console.log(`\n${'='.repeat(60)}`);
            console.log(`📅 DIA: ${data}`);
            console.log('='.repeat(60));

            const startOfDay = new Date(`${data}T00:00:00.000Z`);
            const endOfDay = new Date(`${data}T23:59:59.999Z`);

            // Busca TODOS (inclusive pendentes)
            const todos = await Payment.find({
                $or: [
                    { paymentDate: data },
                    { createdAt: { $gte: startOfDay, $lte: endOfDay } }
                ]
            }).sort({ createdAt: 1 }).lean();

            console.log(`\nTotal encontrado: ${todos.length} pagamentos`);

            // Só os pagos (status paid/completed/confirmed)
            const pagos = todos.filter(p => ['paid', 'completed', 'confirmed'].includes(p.status));
            console.log(`Pagos (status ok): ${pagos.length}`);

            let totalPacote = 0;
            let totalParticular = 0;
            let totalConvenio = 0;
            let totalOutros = 0;

            pagos.forEach((p, i) => {
                const desc = (p.notes || p.description || '').toLowerCase();
                const tipo = p.type;
                
                // Classificação
                let classificacao = 'OUTROS';
                if (tipo === 'package' || tipo === 'pacote' || desc.includes('pacote')) {
                    classificacao = 'PACOTE';
                    totalPacote += p.amount;
                } else if (tipo === 'appointment' || tipo === 'particular' || desc.includes('per-session') || desc.includes('atendimento')) {
                    classificacao = 'PARTICULAR';
                    totalParticular += p.amount;
                } else if (tipo === 'insurance' || tipo === 'convenio' || desc.includes('convênio') || desc.includes('convenio')) {
                    classificacao = 'CONVÊNIO';
                    totalConvenio += p.amount;
                } else {
                    totalOutros += p.amount;
                }

                console.log(`\n  #${i+1} - R$ ${p.amount} - ${classificacao}`);
                console.log(`      Status: ${p.status}`);
                console.log(`      Type: ${tipo || 'NULL'}`);
                console.log(`      Desc: ${desc.substring(0, 40)}${desc.length > 40 ? '...' : ''}`);
            });

            console.log(`\n--- RESUMO ${data} ---`);
            console.log(`💰 Total em Caixa: R$ ${totalPacote + totalParticular + totalConvenio + totalOutros}`);
            console.log(`📦 Pacote: R$ ${totalPacote}`);
            console.log(`👤 Particular: R$ ${totalParticular}`);
            console.log(`🏥 Convênio: R$ ${totalConvenio}`);
            console.log(`❓ Outros: R$ ${totalOutros}`);
        }

    } catch (error) {
        console.error('❌ Erro:', error);
    } finally {
        await mongoose.disconnect();
        console.log('\n✅ Desconectado');
    }
}

diagnostico();
