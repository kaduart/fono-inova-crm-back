// scripts/reconciliacao-convenio-por-paciente.js
// ============================================================
// Atualiza sessionValue e Payment.amount para sessões de convênio
// de MARÇO/2026 baseado na regra por paciente.
//
// Regra identificada:
//   Kauana Queiroz Gomes Nave → unimed-anapolis → R$ 80
//   Nicolas Lucca             → unimed-anapolis → R$ 80
//   Joaquim Rocha Simão       → unimed-anapolis → R$ 80
//   Benjamim Rocha Simão      → unimed-anapolis → R$ 80
//   Davi Felipe Araújo        → unimed-campinas → R$ 140
//
// Uso: node scripts/reconciliacao-convenio-por-paciente.js [dry-run]
// ============================================================

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import moment from 'moment-timezone';
import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import Patient from '../models/Patient.js';
import Payment from '../models/Payment.js';

dotenv.config();

const TIMEZONE = 'America/Sao_Paulo';
const DRY_RUN = process.argv.includes('dry-run');

const MARCO_START = moment.tz('2026-03-01', TIMEZONE).startOf('day').toDate();
const MARCO_END = moment.tz('2026-03-31', TIMEZONE).endOf('day').toDate();

// Mapeamento paciente → valor (identificado pela análise)
const REGRA_PACIENTE = {
    // Anápolis = R$ 80
    'Kauana Queiroz Gomes Nave': { valor: 80, convenio: 'unimed-anapolis' },
    'Nicolas Lucca': { valor: 80, convenio: 'unimed-anapolis' },
    'Joaquim Rocha Simão': { valor: 80, convenio: 'unimed-anapolis' },
    'Benjamim Rocha Simão': { valor: 80, convenio: 'unimed-anapolis' },
    // Campinas = R$ 140
    'Davi Felipe Araújo': { valor: 140, convenio: 'unimed-campinas' }
};

function normalizarNome(nome) {
    return (nome || '').trim().toLowerCase();
}

async function main() {
    console.log(`[Convenio por Paciente] Iniciando... ${DRY_RUN ? '(DRY-RUN)' : '(EXECUÇÃO REAL)'}`);

    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!mongoUri) throw new Error('MONGO_URI não encontrado no .env');
    await mongoose.connect(mongoUri);

    const sessions = await Session.find({
        status: 'completed',
        date: { $gte: MARCO_START, $lte: MARCO_END },
        $or: [
            { paymentMethod: 'convenio' },
            { insuranceGuide: { $exists: true, $ne: null } }
        ]
    }).sort({ date: 1 }).lean();

    let atualizadosSession = 0;
    let atualizadosPayment = 0;
    let criadosPayment = 0;
    let skipped = 0;
    let naoMapeado = 0;
    const logAuditoria = [];

    for (const s of sessions) {
        const patient = await Patient.findById(s.patient).select('fullName').lean();
        const nomePaciente = patient?.fullName || '';
        const nomeNormalizado = normalizarNome(nomePaciente);

        // Encontrar regra pelo nome
        let regra = null;
        for (const [nomeConfig, cfg] of Object.entries(REGRA_PACIENTE)) {
            if (nomeNormalizado.includes(normalizarNome(nomeConfig))) {
                regra = cfg;
                break;
            }
        }

        if (!regra) {
            console.log(`[⚠️ NÃO MAPEADO] Sessão ${s._id} | Paciente: ${nomePaciente}`);
            naoMapeado++;
            continue;
        }

        const valor = regra.valor;
        const convenio = regra.convenio;
        const dataStr = moment(s.date).tz(TIMEZONE).format('YYYY-MM-DD');

        // Verifica se já está OK
        const existingPayment = await Payment.findOne({
            $or: [{ session: s._id }, { sessionId: s._id.toString() }]
        }).select('_id amount billingType insurance.provider').lean();

        if (s.sessionValue === valor && existingPayment && existingPayment.amount === valor) {
            skipped++;
            continue;
        }

        logAuditoria.push({
            data: dataStr,
            paciente: nomePaciente,
            sessionId: s._id.toString(),
            valorAnterior: s.sessionValue || 0,
            valorNovo: valor,
            convenio,
            paymentId: existingPayment?._id?.toString() || null,
            acao: existingPayment ? 'atualizar' : 'criar'
        });

        if (DRY_RUN) {
            console.log(`[DRY-RUN] ${dataStr} | ${nomePaciente.substring(0, 25)} | R$ ${valor} | ${convenio} | ${existingPayment ? 'atualiza Payment' : 'cria Payment'}`);
            continue;
        }

        // 1. Atualizar Session
        await Session.findByIdAndUpdate(s._id, {
            $set: {
                sessionValue: valor,
                insuranceProvider: convenio,
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
                    'insurance.provider': convenio,
                    billingType: 'convenio',
                    updatedAt: new Date(),
                    notes: `[RECONCILIAÇÃO POR PACIENTE: ${nomePaciente}] ${existingPayment.notes || ''}`.trim()
                }
            });
            atualizadosPayment++;
            console.log(`[ATUALIZADO] Payment ${existingPayment._id} → R$ ${valor}`);
        } else {
            const appointment = await Appointment.findOne({ session: s._id }).select('patient doctor').lean();
            const now = new Date();
            const payment = await Payment.create({
                patient: appointment?.patient || s.patient,
                doctor: appointment?.doctor || s.doctor,
                amount: valor,
                status: 'pending',
                type: 'service',
                serviceType: 'session',
                paymentMethod: 'convenio',
                paymentDate: dataStr,
                billingType: 'convenio',
                insurance: {
                    provider: convenio,
                    status: 'pending_billing',
                    grossAmount: valor
                },
                serviceDate: dataStr,
                description: `Sessão convênio realizada - ${nomePaciente}`,
                session: s._id,
                kind: 'session_payment',
                createdAt: now,
                updatedAt: now
            });
            await Session.findByIdAndUpdate(s._id, { paymentId: payment._id });
            criadosPayment++;
            console.log(`[CRIADO] Payment ${payment._id} → R$ ${valor} | ${nomePaciente}`);
        }
    }

    console.log('\n========================================');
    console.log('[Convenio por Paciente] RESUMO');
    console.log('========================================');
    console.log(`Total sessões:        ${sessions.length}`);
    console.log(`Sessions atualizadas: ${atualizadosSession}`);
    console.log(`Payments atualizados: ${atualizadosPayment}`);
    console.log(`Payments criados:     ${criadosPayment}`);
    console.log(`Skipped (já OK):      ${skipped}`);
    console.log(`Não mapeados:         ${naoMapeado}`);
    console.log(`Modo:                 ${DRY_RUN ? 'DRY-RUN' : 'EXECUÇÃO REAL'}`);
    console.log('========================================');

    if (logAuditoria.length > 0) {
        console.log('\nAUDITORIA:');
        console.table(logAuditoria);
    }

    await mongoose.disconnect();
    process.exit(0);
}

main().catch(err => {
    console.error('[Convenio por Paciente] Erro fatal:', err);
    process.exit(1);
});
