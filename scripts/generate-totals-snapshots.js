#!/usr/bin/env node
// scripts/generate-totals-snapshots.js
/**
 * Gera snapshots iniciais para acelerar o dashboard
 * Executar: node scripts/generate-totals-snapshots.js
 */

import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import moment from 'moment-timezone';
import TotalsSnapshot from '../models/TotalsSnapshot.js';
import Payment from '../models/Payment.js';
import PackagesView from '../models/PackagesView.js';
import PatientBalance from '../models/PatientBalance.js';

const TIMEZONE = 'America/Sao_Paulo';

async function generateSnapshot(clinicId, dateStr, period) {
    const targetDate = moment.tz(dateStr, TIMEZONE);
    
    let rangeStart, rangeEnd;
    switch (period) {
        case "day":
            rangeStart = targetDate.clone().startOf('day').toDate();
            rangeEnd = targetDate.clone().endOf('day').toDate();
            break;
        case "week":
            rangeStart = targetDate.clone().startOf('week').toDate();
            rangeEnd = targetDate.clone().endOf('week').toDate();
            break;
        case "month":
            rangeStart = targetDate.clone().startOf('month').toDate();
            rangeEnd = targetDate.clone().endOf('month').toDate();
            break;
        default:
            rangeStart = targetDate.clone().startOf('month').toDate();
            rangeEnd = targetDate.clone().endOf('month').toDate();
    }

    const matchStage = {
        status: { $ne: 'canceled' },
        $or: [
            {
                paymentDate: {
                    $gte: rangeStart.toISOString().split('T')[0],
                    $lte: rangeEnd.toISOString().split('T')[0]
                }
            },
            {
                paymentDate: { $exists: false },
                createdAt: { $gte: rangeStart, $lte: rangeEnd }
            }
        ]
    };

    if (clinicId !== 'default') matchStage.clinicId = clinicId;

    // Agregações
    const [paymentResult, packageResult, balanceResult] = await Promise.all([
        Payment.aggregate([
            { $match: matchStage },
            {
                $group: {
                    _id: null,
                    totalReceived: { 
                        $sum: { 
                            $cond: [
                                { $or: [
                                    { $eq: ["$status", "paid"] },
                                    { $eq: ["$insurance.status", "received"] }
                                ]}, 
                                "$amount", 0
                            ] 
                        } 
                    },
                    totalProduction: {
                        $sum: {
                            $cond: [
                                { $or: [
                                    { $eq: ["$status", "paid"] },
                                    { $in: ["$insurance.status", ["pending_billing", "billed", "received"]] }
                                ]},
                                "$amount", 0
                            ]
                        }
                    },
                    totalPending: { 
                        $sum: { $cond: [{ $eq: ["$status", "pending"] }, "$amount", 0] } 
                    },
                    countReceived: { 
                        $sum: { 
                            $cond: [
                                { $or: [
                                    { $eq: ["$status", "paid"] },
                                    { $eq: ["$insurance.status", "received"] }
                                ]}, 
                                1, 0
                            ] 
                        } 
                    },
                    countPending: { 
                        $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] } 
                    },
                    particularReceived: {
                        $sum: {
                            $cond: [
                                { $and: [
                                    { $eq: ["$status", "paid"] },
                                    { $ne: ["$billingType", "convenio"] }
                                ]},
                                "$amount", 0
                            ]
                        }
                    },
                    insurancePendingBilling: {
                        $sum: { $cond: [{ $eq: ["$insurance.status", "pending_billing"] }, "$amount", 0] }
                    },
                    insuranceBilled: {
                        $sum: { $cond: [{ $eq: ["$insurance.status", "billed"] }, "$amount", 0] }
                    },
                    insuranceReceived: {
                        $sum: { $cond: [{ $eq: ["$insurance.status", "received"] }, "$amount", 0] }
                    }
                }
            }
        ]),
        
        PackagesView.aggregate([
            { $match: { status: { $in: ['active', 'finished'] } } },
            {
                $group: {
                    _id: null,
                    contractedRevenue: { $sum: "$totalValue" },
                    cashReceived: { $sum: "$totalPaid" },
                    deferredSessions: { $sum: "$sessionsRemaining" },
                    deferredRevenue: { $sum: { $multiply: ["$sessionsRemaining", "$sessionValue"] } },
                    recognizedSessions: { $sum: "$sessionsUsed" },
                    recognizedRevenue: { $sum: { $multiply: ["$sessionsUsed", "$sessionValue"] } },
                    totalSessions: { $sum: "$totalSessions" },
                    activePackages: { $sum: 1 }
                }
            }
        ]),
        
        PatientBalance.aggregate([
            {
                $group: {
                    _id: null,
                    totalDebt: { $sum: { $cond: [{ $gt: ["$currentBalance", 0] }, "$currentBalance", 0] } },
                    totalCredit: { $sum: { $cond: [{ $lt: ["$currentBalance", 0] }, { $multiply: ["$currentBalance", -1] }, 0] } },
                    totalDebited: { $sum: "$totalDebited" },
                    totalCredited: { $sum: "$totalCredited" },
                    patientsWithDebt: { $sum: { $cond: [{ $gt: ["$currentBalance", 0] }, 1, 0] } },
                    patientsWithCredit: { $sum: { $cond: [{ $lt: ["$currentBalance", 0] }, 1, 0] } }
                }
            }
        ])
    ]);

    const p = paymentResult[0] || {};
    const pkg = packageResult[0] || {};
    const bal = balanceResult[0] || {};

    const totals = {
        totalReceived: p.totalReceived || 0,
        totalProduction: p.totalProduction || 0,
        totalPending: p.totalPending || 0,
        countReceived: p.countReceived || 0,
        countPending: p.countPending || 0,
        particularReceived: p.particularReceived || 0,
        insurance: {
            pendingBilling: p.insurancePendingBilling || 0,
            billed: p.insuranceBilled || 0,
            received: p.insuranceReceived || 0
        },
        packageCredit: {
            contractedRevenue: pkg.contractedRevenue || 0,
            cashReceived: pkg.cashReceived || 0,
            deferredRevenue: Math.max(0, pkg.deferredRevenue || 0),
            deferredSessions: Math.max(0, pkg.deferredSessions || 0),
            recognizedRevenue: pkg.recognizedRevenue || 0,
            recognizedSessions: pkg.recognizedSessions || 0,
            totalSessions: pkg.totalSessions || 0,
            activePackages: pkg.activePackages || 0
        },
        patientBalance: {
            totalDebt: bal.totalDebt || 0,
            totalCredit: bal.totalCredit || 0,
            totalDebited: bal.totalDebited || 0,
            totalCredited: bal.totalCredited || 0,
            patientsWithDebt: bal.patientsWithDebt || 0,
            patientsWithCredit: bal.patientsWithCredit || 0
        }
    };

    // Salva snapshot
    await TotalsSnapshot.findOneAndUpdate(
        { clinicId, date: dateStr, period },
        {
            clinicId,
            date: dateStr,
            period,
            totals,
            calculatedAt: new Date()
        },
        { upsert: true, new: true }
    );

    return totals;
}

async function main() {
    try {
        console.log('🔌 Conectando ao MongoDB...');
        await mongoose.connect(process.env.MONGO_URI);
        console.log(`✅ Conectado: ${mongoose.connection.db.databaseName}\n`);
        
        const clinicId = process.argv[2] || 'default';
        
        // Gerar para os últimos 3 meses + mês atual
        const months = [];
        for (let i = -2; i <= 1; i++) {
            months.push(moment().add(i, 'months').format('YYYY-MM'));
        }
        
        console.log(`🚀 Gerando snapshots para clinic: ${clinicId}`);
        console.log(`📅 Meses: ${months.join(', ')}\n`);
        
        for (const month of months) {
            const startTime = Date.now();
            const dateStr = `${month}-01`;
            
            console.log(`⏳ Processando ${month}...`);
            
            const totals = await generateSnapshot(clinicId, dateStr, 'month');
            
            const duration = Date.now() - startTime;
            
            console.log(`✅ ${month} completo em ${duration}ms`);
            console.log(`   💰 Recebido: ${totals.totalReceived.toFixed(2)}`);
            console.log(`   📊 Produção: ${totals.totalProduction.toFixed(2)}`);
            console.log(`   📦 Pacotes: ${totals.packageCredit.activePackages} ativos`);
            console.log();
        }
        
        // Também gera para 'day' (hoje)
        const today = moment().format('YYYY-MM-DD');
        console.log(`⏳ Processando hoje (${today})...`);
        await generateSnapshot(clinicId, today, 'day');
        console.log(`✅ Hoje completo\n`);
        
        console.log('🎉 Todos os snapshots gerados com sucesso!');
        console.log('⚡ O dashboard agora vai carregar muito mais rápido.');
        
    } catch (error) {
        console.error('\n❌ Erro:', error.message);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        console.log('\n🔌 Desconectado');
    }
}

main();
