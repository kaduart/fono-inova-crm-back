#!/usr/bin/env node
/**
 * 🏦 SCRIPT DE RECONCILIAÇÃO FINANCEIRA
 * 
 * Verifica se há divergência entre:
 * - Total de Payments confirmados
 * - Total do Ledger (créditos)
 * 
 * Uso: node scripts/reconcileLedger.js [data_inicio] [data_fim]
 * Ex: node scripts/reconcileLedger.js 2026-01-01 2026-12-31
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import FinancialLedger from '../models/FinancialLedger.js';
import Payment from '../models/Payment.js';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

async function reconcile() {
    console.log('🏦 Iniciando reconciliação financeira...\n');
    
    await mongoose.connect(MONGO_URI);
    console.log('✅ MongoDB conectado\n');
    
    // Período: últimos 30 dias ou argumentos
    const args = process.argv.slice(2);
    const startDate = args[0] ? new Date(args[0]) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const endDate = args[1] ? new Date(args[1]) : new Date();
    
    console.log(`📅 Período: ${startDate.toISOString().split('T')[0]} a ${endDate.toISOString().split('T')[0]}\n`);
    
    // 1. Total do Ledger (créditos)
    const ledgerResult = await FinancialLedger.reconcile({
        occurredAt: { $gte: startDate, $lte: endDate }
    });
    
    console.log('📒 LEDGER:');
    console.log(`   Créditos:  R$ ${ledgerResult.credit.toFixed(2)}`);
    console.log(`   Débitos:   R$ ${ledgerResult.debit.toFixed(2)}`);
    console.log(`   Saldo:     R$ ${ledgerResult.balance.toFixed(2)}\n`);
    
    // 2. Total de Payments confirmados
    const paymentsResult = await Payment.aggregate([
        {
            $match: {
                status: 'paid',
                paidAt: { $gte: startDate, $lte: endDate }
            }
        },
        {
            $group: {
                _id: null,
                total: { $sum: '$amount' },
                count: { $sum: 1 }
            }
        }
    ]);
    
    const paymentsTotal = paymentsResult[0]?.total || 0;
    const paymentsCount = paymentsResult[0]?.count || 0;
    
    console.log('💳 PAYMENTS (status=paid):');
    console.log(`   Total: R$ ${paymentsTotal.toFixed(2)}`);
    console.log(`   Quantidade: ${paymentsCount}\n`);
    
    // 3. Verificar divergência
    const difference = Math.abs(ledgerResult.credit - paymentsTotal);
    const tolerance = 0.01; // tolerância de 1 centavo
    
    console.log('📊 ANÁLISE:');
    console.log(`   Diferença: R$ ${difference.toFixed(2)}`);
    
    if (difference <= tolerance) {
        console.log('   ✅ STATUS: CONCILIADO\n');
    } else {
        console.log('   🚨 STATUS: DIVERGÊNCIA DETECTADA\n');
        
        // Busca lançamentos sem payment correspondente
        const orphanLedgers = await FinancialLedger.find({
            occurredAt: { $gte: startDate, $lte: endDate },
            direction: 'credit',
            $or: [
                { payment: null },
                { payment: { $exists: false } }
            ]
        }).limit(10);
        
        if (orphanLedgers.length > 0) {
            console.log('📝 Lançamentos sem payment:');
            orphanLedgers.forEach(l => {
                console.log(`   - ${l._id}: ${l.type} - R$ ${l.amount}`);
            });
        }
        
        // Busca payments sem ledger
        const paymentsWithLedger = await FinancialLedger.distinct('payment', {
            occurredAt: { $gte: startDate, $lte: endDate }
        });
        
        const orphanPayments = await Payment.find({
            status: 'paid',
            paidAt: { $gte: startDate, $lte: endDate },
            _id: { $nin: paymentsWithLedger }
        }).limit(10);
        
        if (orphanPayments.length > 0) {
            console.log('\n💳 Payments sem ledger:');
            orphanPayments.forEach(p => {
                console.log(`   - ${p._id}: R$ ${p.amount}`);
            });
        }
    }
    
    // 4. Resumo por tipo
    console.log('\n📈 POR TIPO (Ledger):');
    const byType = await FinancialLedger.aggregate([
        {
            $match: {
                occurredAt: { $gte: startDate, $lte: endDate }
            }
        },
        {
            $group: {
                _id: { type: '$type', direction: '$direction' },
                total: { $sum: '$amount' },
                count: { $sum: 1 }
            }
        },
        { $sort: { '_id.type': 1 } }
    ]);
    
    byType.forEach(t => {
        const direction = t._id.direction === 'credit' ? '+' : '-';
        console.log(`   ${direction} ${t._id.type}: R$ ${t.total.toFixed(2)} (${t.count}x)`);
    });
    
    await mongoose.disconnect();
    console.log('\n🔌 Desconectado');
    
    // Exit code para CI/CD
    process.exit(difference <= tolerance ? 0 : 1);
}

reconcile().catch(err => {
    console.error('❌ Erro:', err.message);
    process.exit(1);
});
