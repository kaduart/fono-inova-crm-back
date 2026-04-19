// scripts/criar-payments-cancelados.js
// Cria novos Payments PENDING para sessões de convênio de março
// que ficaram sem Payment ativo após cancelamento dos órfãos do V1.
//
// Uso: node scripts/criar-payments-cancelados.js [dry-run]

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

const REGRA_PACIENTE = {
    'Kauana Queiroz Gomes Nave': { valor: 80, convenio: 'unimed-anapolis' },
    'Nicolas Lucca': { valor: 80, convenio: 'unimed-anapolis' },
    'Joaquim Rocha Simão': { valor: 80, convenio: 'unimed-anapolis' },
    'Benjamim Rocha Simão': { valor: 80, convenio: 'unimed-anapolis' },
    'Davi Felipe Araújo': { valor: 140, convenio: 'unimed-campinas' }
};

function normalizarNome(nome) {
    return (nome || '').trim().toLowerCase();
}

async function main() {
    console.log(`[Criar Payments Cancelados] Iniciando... ${DRY_RUN ? '(DRY-RUN)' : '(EXECUÇÃO REAL)'}`);

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

    let criados = 0;
    let skipped = 0;
    const logAuditoria = [];

    for (const s of sessions) {
        // Verificar se existe Payment ATIVO (pending, billed, paid)
        const activePayment = await Payment.findOne({
            $or: [
                { session: s._id },
                { sessionId: s._id.toString() }
            ],
            status: { $nin: ['canceled'] }
        }).select('_id amount status').lean();

        if (activePayment) {
            skipped++;
            continue;
        }

        // Buscar dados para criar Payment
        const patient = await Patient.findById(s.patient).select('fullName').lean();
        const appointment = await Appointment.findOne({ session: s._id }).select('patient doctor').lean();
        const nomePaciente = patient?.fullName || '';
        const nomeNormalizado = normalizarNome(nomePaciente);

        let regra = null;
        for (const [nomeConfig, cfg] of Object.entries(REGRA_PACIENTE)) {
            if (nomeNormalizado.includes(normalizarNome(nomeConfig))) {
                regra = cfg;
                break;
            }
        }

        const valor = regra?.valor || s.sessionValue || 80;
        const convenio = regra?.convenio || 'unimed-anapolis';
        const dataStr = moment(s.date).tz(TIMEZONE).format('YYYY-MM-DD');

        logAuditoria.push({
            data: dataStr,
            paciente: nomePaciente,
            sessionId: s._id.toString(),
            valor,
            convenio
        });

        if (DRY_RUN) {
            console.log(`[DRY-RUN] Criaria Payment para ${nomePaciente} | ${dataStr} | R$ ${valor}`);
            continue;
        }

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
        criados++;
        console.log(`[CRIADO] Payment ${payment._id} → R$ ${valor} | ${nomePaciente} | ${dataStr}`);
    }

    console.log('\n========================================');
    console.log('[Criar Payments Cancelados] RESUMO');
    console.log('========================================');
    console.log(`Total sessões:    ${sessions.length}`);
    console.log(`Criados:          ${criados}`);
    console.log(`Skipped (já OK):  ${skipped}`);
    console.log(`Modo:             ${DRY_RUN ? 'DRY-RUN' : 'EXECUÇÃO REAL'}`);
    console.log('========================================');

    if (logAuditoria.length > 0) {
        console.log('\nAUDITORIA:');
        console.table(logAuditoria);
    }

    await mongoose.disconnect();
    process.exit(0);
}

main().catch(err => {
    console.error('[Criar Payments Cancelados] Erro fatal:', err);
    process.exit(1);
});
