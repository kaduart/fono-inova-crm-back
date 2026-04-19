// scripts/reconciliacao-abril-cancelar-orfaos.js
// ============================================================
// CANCELA payments pending de ABRIL/2026 sem session válida
//
// Contexto: Duplicatas V1, payments criados para sessions deletadas,
// ou órfãos sem vínculo.
//
// Uso: node scripts/reconciliacao-abril-cancelar-orfaos.js [dry-run]
// ============================================================

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import moment from 'moment-timezone';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';

dotenv.config();

const TIMEZONE = 'America/Sao_Paulo';
const DRY_RUN = process.argv.includes('dry-run');

const ABRIL_START = moment.tz('2026-04-01', TIMEZONE).startOf('day').toDate();
const ABRIL_END = moment.tz('2026-04-30', TIMEZONE).endOf('day').toDate();

async function main() {
    console.log(`[Abril Cancelar Órfãos] Iniciando... ${DRY_RUN ? '(DRY-RUN)' : '(EXECUÇÃO REAL)'}`);

    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!mongoUri) throw new Error('MONGO_URI não encontrado no .env');
    await mongoose.connect(mongoUri);
    console.log('[Abril Cancelar Órfãos] Conectado ao MongoDB');

    // Buscar todos os payments pending de abril
    const pendingPayments = await Payment.find({
        status: 'pending',
        paymentDate: { $gte: ABRIL_START, $lte: ABRIL_END }
    }).lean();

    console.log(`[Abril Cancelar Órfãos] Total pending payments abril: ${pendingPayments.length}`);

    // Verificar quais sessions existem
    const sessionIds = pendingPayments.map(p => p.session).filter(id => id);
    const existingSessions = await Session.find({ _id: { $in: sessionIds } }).select('_id').lean();
    const existingSessionSet = new Set(existingSessions.map(s => s._id.toString()));

    // Verificar quais appointments existem
    const appIds = pendingPayments.map(p => p.appointment).filter(id => id);
    const existingApps = await Appointment.find({ _id: { $in: appIds } }).select('_id').lean();
    const existingAppSet = new Set(existingApps.map(a => a._id.toString()));

    let cancelados = 0;
    let mantidos = 0;
    let erros = 0;
    let totalCancelado = 0;

    for (const p of pendingPayments) {
        try {
            const hasSession = p.session && existingSessionSet.has(p.session.toString());
            const hasAppointment = p.appointment && existingAppSet.has(p.appointment.toString());

            if (hasSession) {
                // Session existe — manter
                console.log(`[MANTIDO] Payment ${p._id}: R$ ${p.amount} — session ${p.session} existe`);
                mantidos++;
                continue;
            }

            if (hasAppointment) {
                // Appointment existe mas session não — investigar
                // Se não tem session, é provavelmente uma duplicata ou agendamento cancelado
                console.log(`[CANCELAR] Payment ${p._id}: R$ ${p.amount} — appointment ${p.appointment} existe mas session ${p.session || 'null'} não existe`);
            } else {
                // Nem session nem appointment — órfão confirmado
                console.log(`[CANCELAR] Payment ${p._id}: R$ ${p.amount} — sem session e sem appointment`);
            }

            if (!DRY_RUN) {
                await Payment.findByIdAndUpdate(p._id, {
                    $set: {
                        status: 'canceled',
                        notes: `[RECONCILIAÇÃO ABRIL: cancelado pois não possui session válida vinculada] ${p.notes || ''}`.trim(),
                        updatedAt: new Date()
                    }
                });
            }
            cancelados++;
            totalCancelado += p.amount || 0;

        } catch (err) {
            console.error(`[ERRO] Payment ${p._id}:`, err.message);
            erros++;
        }
    }

    console.log('\n========================================');
    console.log('[Abril Cancelar Órfãos] RESUMO');
    console.log('========================================');
    console.log(`Total analisado:        ${pendingPayments.length}`);
    console.log(`Cancelados:             ${cancelados}`);
    console.log(`Valor cancelado:        R$ ${totalCancelado.toFixed(2)}`);
    console.log(`Mantidos (com session): ${mantidos}`);
    console.log(`Erros:                  ${erros}`);
    console.log(`Modo:                   ${DRY_RUN ? 'DRY-RUN' : 'EXECUÇÃO REAL'}`);
    console.log('========================================');

    await mongoose.disconnect();
    process.exit(0);
}

main().catch(err => {
    console.error('[Abril Cancelar Órfãos] Erro fatal:', err);
    process.exit(1);
});
