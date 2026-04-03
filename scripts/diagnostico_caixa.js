#!/usr/bin/env node
/**
 * Diagnóstico de Caixa - Dia 02/04/2026
 * Verifica o que tem no banco de dados
 */

import mongoose from 'mongoose';
import Payment from '../models/Payment.js';
import dotenv from 'dotenv';

dotenv.config();

async function diagnostico() {
    try {
        const uri = process.env.MONGODB_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development?retryWrites=true&w=majority';
        console.log('Conectando em:', uri.substring(0, 50) + '...\n');
        await mongoose.connect(uri);
        console.log('✅ Conectado ao MongoDB\n');

        const data = '2026-04-02';
        const startOfDay = new Date(`${data}T00:00:00.000Z`);
        const endOfDay = new Date(`${data}T23:59:59.999Z`);

        console.log(`🔍 Buscando pagamentos do dia ${data}...\n`);

        // Busca todos os pagamentos do dia
        const payments = await Payment.find({
            $or: [
                {
                    paymentDate: data
                },
                {
                    createdAt: { $gte: startOfDay, $lte: endOfDay }
                }
            ]
        }).lean();

        console.log(`📊 Total de pagamentos encontrados: ${payments.length}\n`);

        if (payments.length === 0) {
            console.log('❌ Nenhum pagamento encontrado nesta data');
            return;
        }

        // Mostra detalhes de cada um
        payments.forEach((p, i) => {
            console.log(`--- Pagamento #${i + 1} ---`);
            console.log(`ID: ${p._id}`);
            console.log(`Valor: R$ ${p.amount}`);
            console.log(`Tipo (type): ${p.type || 'NULL/VAZIO'}`);
            console.log(`Método (paymentMethod): ${p.paymentMethod || 'NULL/VAZIO'}`);
            console.log(`Descrição: ${p.description || 'NULL/VAZIO'}`);
            console.log(`Notas: ${p.notes || 'NULL/VAZIO'}`);
            console.log(`Data (paymentDate): ${p.paymentDate || 'NULL/VAZIO'}`);
            console.log(`Criado em: ${p.createdAt}`);
            console.log(`Status: ${p.status}`);
            console.log('');
        });

        // Soma por tipo
        const porTipo = {
            package: payments.filter(p => p.type === 'package' || p.type === 'pacote').reduce((s, p) => s + p.amount, 0),
            appointment: payments.filter(p => p.type === 'appointment' || !p.type).reduce((s, p) => s + p.amount, 0),
            insurance: payments.filter(p => p.type === 'insurance' || p.type === 'convenio').reduce((s, p) => s + p.amount, 0),
        };

        console.log('--- Resumo por Tipo (campo type) ---');
        console.log(`Pacote: R$ ${porTipo.package}`);
        console.log(`Particular: R$ ${porTipo.appointment}`);
        console.log(`Convênio: R$ ${porTipo.insurance}`);
        console.log('');

        // Verifica descrições
        console.log('--- Análise de Descrições ---');
        payments.forEach((p, i) => {
            const desc = (p.description || p.notes || '').toLowerCase();
            console.log(`#${i + 1}: "${desc.substring(0, 50)}..."`);
            console.log(`  → Contém 'pacote'? ${desc.includes('pacote')}`);
            console.log(`  → Contém 'per-session'? ${desc.includes('per-session')}`);
            console.log(`  → Contém 'atendimento'? ${desc.includes('atendimento')}`);
            console.log(`  → Contém 'convênio'? ${desc.includes('convênio') || desc.includes('convenio')}`);
            console.log('');
        });

    } catch (error) {
        console.error('❌ Erro:', error);
    } finally {
        await mongoose.disconnect();
        console.log('\n✅ Desconectado');
    }
}

diagnostico();
