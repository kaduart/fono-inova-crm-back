// scripts/reconciliacao-convenio-valores-zerados.js
// ============================================================
// BACKFILL DE VALORES: Atualiza sessionValue e Payment.amount
// para sessões de convênio com valor zerado em MARÇO/2026.
//
// Regra:
//   unimed-anapolis  → R$ 80
//   unimed-campinas  → R$ 140
//   não identificado → R$ 80 (default conservador)
//
// Uso: node scripts/reconciliacao-convenio-valores-zerados.js [dry-run]
// ============================================================

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import moment from 'moment-timezone';
import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import Payment from '../models/Payment.js';

dotenv.config();

const TIMEZONE = 'America/Sao_Paulo';
const DRY_RUN = process.argv.includes('dry-run');

const MARCO_START = moment.tz('2026-03-01', TIMEZONE).startOf('day').toDate();
const MARCO_END = moment.tz('2026-03-31', TIMEZONE).endOf('day').toDate();

// Mapeamento de regra
function inferirValor(provider) {
    const p = (provider || '').toLowerCase().trim();
    if (p.includes('campinas')) return 140;
    if (p.includes('anapolis') || p.includes('anápolis')) return 80;
    // Default conservador
    return 80;
}

async function main() {
    console.log(`[Convenio Valores Zerados] Iniciando... ${DRY_RUN ? '(DRY-RUN)' : '(EXECUÇÃO REAL)'}`);

    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!mongoUri) throw new Error('MONGO_URI não encontrado no .env');
    await mongoose.connect(mongoUri);

    // Buscar sessões de convênio em março com sessionValue = 0 ou sem Payment
    const sessions = await Session.find({
        status: 'completed',
        date: { $gte: MARCO_START, $lte: MARCO_END },
        $or: [
            { paymentMethod: 'convenio' },
            { insuranceGuide: { $exists: true, $ne: null } }
        ]
    }).select('_id date sessionValue insuranceProvider insuranceGuide paymentMethod').lean();

    let atualizadosSession = 0;
    let atualizadosPayment = 0;
    let criadosPayment = 0;
    let skipped = 0;
    const logAuditoria = [];

    for (const session of sessions) {
        // Pula sessões que já têm valor > 0 E já têm Payment com valor > 0
        const existingPayment = await Payment.findOne({
            $or: [
                { session: session._id },
                { sessionId: session._id.toString() }
            ]
        }).select('_id amount billingType insurance.provider').lean();

        if (session.sessionValue > 0 && existingPayment && existingPayment.amount > 0) {
            skipped++;
            continue;
        }

        // Tentar inferir convênio de múltiplas fontes
        let provider = session.insuranceProvider;
        let fonte = 'session.insuranceProvider';

        if (!provider) {
            const appointment = await Appointment.findOne({ session: session._id }).lean();
            if (appointment?.insuranceProvider) {
                provider = appointment.insuranceProvider;
                fonte = 'appointment.insuranceProvider';
            } else if (appointment?.insurance?.provider) {
                provider = appointment.insurance.provider;
                fonte = 'appointment.insurance.provider';
            }
        }

        const valor = inferirValor(provider);
        const dataStr = moment(session.date).tz(TIMEZONE).format('YYYY-MM-DD');
        const providerLog = provider || 'NÃO_IDENTIFICADO';

        logAuditoria.push({
            sessionId: session._id.toString(),
            data: dataStr,
            valorAnterior: session.sessionValue || 0,
            valorNovo: valor,
            provider: providerLog,
            fonte,
            paymentExistente: existingPayment?._id?.toString() || null,
            acao: existingPayment ? 'atualizar_payment' : 'criar_payment'
        });

        if (DRY_RUN) {
            console.log(`[DRY-RUN] Sessão ${session._id} | ${dataStr} | ${providerLog} | R$ ${valor} | fonte: ${fonte}`);
            continue;
        }

        // 1. Atualizar Session
        await Session.findByIdAndUpdate(session._id, {
            $set: {
                sessionValue: valor,
                updatedAt: new Date()
            }
        });
        atualizadosSession++;

        // 2. Atualizar ou criar Payment
        if (existingPayment) {
            await Payment.findByIdAndUpdate(existingPayment._id, {
                $set: {
                    amount: valor,
                    'insurance.grossAmount': valor,
                    'insurance.provider': provider || existingPayment.insurance?.provider || 'Convênio',
                    updatedAt: new Date(),
                    notes: `[RECONCILIAÇÃO: valor atualizado de ${existingPayment.amount || 0} para ${valor}] ${existingPayment.notes || ''}`.trim()
                }
            });
            atualizadosPayment++;
            console.log(`[ATUALIZADO] Payment ${existingPayment._id} → R$ ${valor} (era R$ ${existingPayment.amount || 0})`);
        } else {
            const now = new Date();
            const payment = await Payment.create({
                patient: session.patient,
                doctor: session.doctor,
                amount: valor,
                status: 'pending',
                type: 'service',
                serviceType: 'session',
                paymentMethod: 'convenio',
                paymentDate: dataStr,
                billingType: 'convenio',
                insurance: {
                    provider: provider || 'Convênio',
                    status: 'pending_billing',
                    grossAmount: valor
                },
                serviceDate: dataStr,
                description: `Sessão convênio realizada - valor reconstruído`,
                session: session._id,
                kind: 'session_payment',
                createdAt: now,
                updatedAt: now
            });
            await Session.findByIdAndUpdate(session._id, { paymentId: payment._id });
            criadosPayment++;
            console.log(`[CRIADO] Payment ${payment._id} → R$ ${valor}`);
        }
    }

    console.log('\n========================================');
    console.log('[Convenio Valores Zerados] RESUMO');
    console.log('========================================');
    console.log(`Total sessões analisadas: ${sessions.length}`);
    console.log(`Sessions atualizadas:     ${atualizadosSession}`);
    console.log(`Payments atualizados:     ${atualizadosPayment}`);
    console.log(`Payments criados:         ${criadosPayment}`);
    console.log(`Skipped (já OK):          ${skipped}`);
    console.log(`Modo:                     ${DRY_RUN ? 'DRY-RUN' : 'EXECUÇÃO REAL'}`);
    console.log('========================================');
    console.log('\nAUDITORIA DETALHADA:');
    console.table(logAuditoria);

    await mongoose.disconnect();
    process.exit(0);
}

main().catch(err => {
    console.error('[Convenio Valores Zerados] Erro fatal:', err);
    process.exit(1);
});
