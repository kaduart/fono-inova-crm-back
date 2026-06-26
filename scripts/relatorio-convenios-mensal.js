/**
 * 📋 RELATÓRIO MENSAL DE CONVÊNIOS ATENDIDOS
 *
 * Gera relatório detalhado de todos os convênios atendidos no mês,
 * separando atendimentos realizados (completed) de outros registros.
 *
 * Uso: node scripts/relatorio-convenios-mensal.js 2026 04
 */

import mongoose from 'mongoose';
import moment from 'moment-timezone';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

// Registra todos os schemas do app para evitar MissingSchemaError
import '../models/index.js';

const Session = mongoose.model('Session');
const Appointment = mongoose.model('Appointment');
const Patient = mongoose.model('Patient');
const Doctor = mongoose.model('Doctor');
const InsuranceGuide = mongoose.model('InsuranceGuide');
const Payment = mongoose.model('Payment');

// InsuranceBatch não está no index.js, importar explicitamente
import InsuranceBatch from '../models/InsuranceBatch.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env') });

const TIMEZONE = 'America/Sao_Paulo';
const OUTPUT_DIR = join(dirname(__dirname), '..', 'auditoria-output');

function fmtBrl(v) {
    if (v == null) return '—';
    return `R$ ${Number(v).toFixed(2).replace('.', ',')}`;
}

function fmtDate(d) {
    if (!d) return '—';
    return moment(d).tz(TIMEZONE).format('DD/MM/YYYY');
}

function fmtDateTime(d) {
    if (!d) return '—';
    return moment(d).tz(TIMEZONE).format('DD/MM/YYYY HH:mm');
}

function normalizeProvider(p) {
    if (!p) return 'NÃO IDENTIFICADO';
    return String(p).toLowerCase().trim();
}

function displayProvider(p) {
    if (!p || p === 'NÃO IDENTIFICADO') return 'Não identificado';
    return String(p)
        .split('-')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

function isConvenioSource(s) {
    return (
        s.paymentMethod === 'convenio' ||
        s.paymentOrigin === 'convenio' ||
        (s.insuranceGuide && String(s.insuranceGuide).length > 0) ||
        (s.insuranceProvider && String(s.insuranceProvider).trim())
    );
}

function isConvenioAppointment(a) {
    return (
        a.billingType === 'convenio' ||
        a.paymentMethod === 'convenio' ||
        (a.insuranceProvider && String(a.insuranceProvider).trim()) ||
        (a.insuranceGuide && String(a.insuranceGuide).length > 0)
    );
}

async function connectDb() {
    if (mongoose.connection.readyState === 1) return;
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!uri) {
        console.error('❌ MONGODB_URI/MONGO_URI não encontrado no .env');
        process.exit(1);
    }
    await mongoose.connect(uri);
    console.log(`🔗 MongoDB conectado: ${uri.split('@').pop()?.split('/').shift()}\n`);
}

async function findBatchInfo(sessionIds) {
    if (!sessionIds.length) return {};
    const batches = await InsuranceBatch.find({
        'sessions.session': { $in: sessionIds.map(id => new mongoose.Types.ObjectId(id)) }
    }).lean();

    const map = {};
    for (const batch of batches) {
        for (const s of batch.sessions || []) {
            if (!s.session) continue;
            const sid = String(s.session);
            if (!map[sid]) map[sid] = [];
            map[sid].push({
                batchNumber: batch.batchNumber,
                provider: batch.insuranceProvider,
                status: batch.status,
                sentDate: batch.sentDate,
                sessionStatus: s.status,
                grossAmount: s.grossAmount,
                netAmount: s.netAmount,
                returnAmount: s.returnAmount,
                glosaAmount: s.glosaAmount
            });
        }
    }
    return map;
}

async function findPaymentInfo(sessionIds) {
    if (!sessionIds.length) return {};
    const payments = await Payment.find({
        $or: [
            { session: { $in: sessionIds.map(id => new mongoose.Types.ObjectId(id)) } },
            { sessions: { $in: sessionIds.map(id => new mongoose.Types.ObjectId(id)) } }
        ]
    }).lean();

    const map = {};
    for (const p of payments) {
        const relatedSessions = [];
        if (p.session) relatedSessions.push(String(p.session));
        if (Array.isArray(p.sessions)) relatedSessions.push(...p.sessions.map(String));

        for (const sid of relatedSessions) {
            if (!map[sid]) map[sid] = [];
            map[sid].push({
                _id: p._id,
                amount: p.amount,
                status: p.status,
                method: p.paymentMethod,
                origin: p.paymentOrigin,
                billingType: p.billingType,
                provider: p.insurance?.provider,
                financialDate: p.financialDate,
                paidAt: p.paidAt
            });
        }
    }
    return map;
}

function buildEntry(item, batchInfo, paymentInfo) {
    const patientName = item.patient?.fullName || `[ID:${String(item.patient?._id || '??').slice(-6)}]`;
    const guideNumber = item.guide?.number || '—';

    const lotes = item.batchInfo && item.batchInfo.length
        ? item.batchInfo.map(b => `${b.batchNumber}[${b.sessionStatus}]`).join(', ')
        : 'Sem lote';

    const payments = item.paymentInfo && item.paymentInfo.length
        ? item.paymentInfo.map(p => `${p.status || '—'}/${fmtBrl(p.amount)}`).join(', ')
        : 'Sem payment';

    return {
        data: item.date ? moment(item.date).tz(TIMEZONE).format('DD/MM') : '—',
        hora: item.date ? moment(item.date).tz(TIMEZONE).format('HH:mm') : '—',
        dataCompleta: item.date ? moment(item.date).tz(TIMEZONE).format('DD/MM/YYYY') : '—',
        paciente: patientName,
        telefone: item.patient?.phone || '',
        profissional: item.doctor?.fullName || '—',
        terapia: String(item.specialty || item.doctor?.specialty || '—').replace(/_/g, ' '),
        valor: item.value ?? 0,
        guia: guideNumber,
        guiaStatus: item.guide?.status || '',
        guiaUso: item.guide ? `${item.guide.usedSessions || 0}/${item.guide.totalSessions || 0}` : '',
        sessionId: item.sessionId,
        appointmentId: item.appointmentId,
        tipo: item.type === 'session' ? 'Sessão' : 'Agendamento',
        paymentMethod: item.paymentMethod || '—',
        paymentOrigin: item.paymentOrigin || '—',
        operationalStatus: item.operationalStatus,
        lotes,
        payments
    };
}

function groupByConvenioPatientDay(items) {
    const porConvenio = {};

    for (const item of items) {
        const providerKey = item.provider;
        const providerName = displayProvider(providerKey);
        const patientName = item.patient?.fullName || `[ID:${String(item.patient?._id || '??').slice(-6)}]`;
        const patientPhone = item.patient?.phone || '';
        const day = item.date ? moment(item.date).tz(TIMEZONE).format('DD/MM') : '—';

        if (!porConvenio[providerKey]) {
            porConvenio[providerKey] = {
                name: providerName,
                patients: {},
                totalSessions: 0,
                totalValue: 0
            };
        }

        if (!porConvenio[providerKey].patients[patientName]) {
            porConvenio[providerKey].patients[patientName] = {
                phone: patientPhone,
                days: {},
                totalSessions: 0,
                totalValue: 0
            };
        }

        if (!porConvenio[providerKey].patients[patientName].days[day]) {
            porConvenio[providerKey].patients[patientName].days[day] = [];
        }

        const entry = buildEntry(item);
        porConvenio[providerKey].patients[patientName].days[day].push(entry);
        porConvenio[providerKey].patients[patientName].totalSessions += 1;
        porConvenio[providerKey].patients[patientName].totalValue += entry.valor;
        porConvenio[providerKey].totalSessions += 1;
        porConvenio[providerKey].totalValue += entry.valor;
    }

    return porConvenio;
}

function renderConvenioSection(lines, porConvenio, title) {
    const sep = '═'.repeat(100);
    const line = '─'.repeat(100);

    if (Object.keys(porConvenio).length === 0) {
        lines.push('');
        lines.push('╔' + '═'.repeat(98) + '╗');
        lines.push(`║  ${title}: nenhum registro`.padEnd(98) + '║');
        lines.push('╚' + '═'.repeat(98) + '╝');
        return;
    }

    const totalSessoes = Object.values(porConvenio).reduce((s, c) => s + c.totalSessions, 0);
    const totalValor = Object.values(porConvenio).reduce((s, c) => s + c.totalValue, 0);

    lines.push('');
    lines.push(sep);
    lines.push(`  ${title}`);
    lines.push(`  ${totalSessoes} registro(s)  •  ${fmtBrl(totalValor)}`);
    lines.push(sep);

    lines.push('┌' + '─'.repeat(98) + '┐');
    lines.push(`│ ${'CONVÊNIO'.padEnd(40)} │ ${'PACIENTES'.padStart(9)} │ ${'REGISTROS'.padStart(9)} │ ${'VALOR TOTAL'.padStart(15)} │`);
    lines.push('├' + '─'.repeat(98) + '┤');

    const sortedProviders = Object.keys(porConvenio).sort((a, b) => porConvenio[b].totalValue - porConvenio[a].totalValue);
    for (const key of sortedProviders) {
        const c = porConvenio[key];
        const numPatients = Object.keys(c.patients).length;
        lines.push(`│ ${c.name.padEnd(40)} │ ${String(numPatients).padStart(9)} │ ${String(c.totalSessions).padStart(9)} │ ${fmtBrl(c.totalValue).padStart(15)} │`);
    }
    lines.push('└' + '─'.repeat(98) + '┘');

    for (const key of sortedProviders) {
        const c = porConvenio[key];
        lines.push('');
        lines.push('▓'.repeat(100));
        lines.push(`  🏥 CONVÊNIO: ${c.name}`);
        lines.push(`  ${c.totalSessions} registro(s)  •  ${fmtBrl(c.totalValue)}`);
        lines.push('▓'.repeat(100));

        const sortedPatients = Object.keys(c.patients).sort();
        for (const patientName of sortedPatients) {
            const p = c.patients[patientName];
            lines.push(line);
            lines.push(`  👤 PACIENTE: ${patientName}${p.phone ? '  (' + p.phone + ')' : ''}`);
            lines.push(`     ${p.totalSessions} registro(s)  •  ${fmtBrl(p.totalValue)}`);
            lines.push(line);

            lines.push(`     DATA   HORA  PROFISSIONAL          TERAPIA              VALOR    GUIA          STATUS     LOTES/PAGAMENTOS`);
            lines.push(`     ${'─'.repeat(92)}`);

            const sortedDays = Object.keys(p.days).sort((a, b) => {
                if (a === '—') return 1;
                if (b === '—') return -1;
                const [da, ma] = a.split('/').map(Number);
                const [db, mb] = b.split('/').map(Number);
                return (ma * 100 + da) - (mb * 100 + db);
            });

            for (const day of sortedDays) {
                for (const e of p.days[day]) {
                    const prof = e.profissional.substring(0, 18).padEnd(18);
                    const terapia = e.terapia.substring(0, 18).padEnd(18);
                    const guia = e.guia.substring(0, 12).padEnd(12);
                    const status = (e.operationalStatus || '').substring(0, 8).padEnd(8);
                    const lotesPag = (e.lotes !== 'Sem lote' ? e.lotes : e.payments).substring(0, 28);
                    lines.push(`     ${e.data}  ${e.hora.padEnd(5)} ${prof} ${terapia} ${fmtBrl(e.valor).padStart(9)} ${guia} ${status} ${lotesPag}`);
                }
            }
            lines.push('');
        }
    }
}

async function runReport(year, month) {
    const monthStart = moment.tz([year, month - 1, 1], TIMEZONE).startOf('day');
    const monthEnd = moment.tz([year, month - 1, 1], TIMEZONE).endOf('month').endOf('day');
    const start = monthStart.clone().utc().toDate();
    const end = monthEnd.clone().utc().toDate();

    console.log(`📅 Período: ${monthStart.format('MMMM/YYYY')} (${year}-${String(month).padStart(2, '0')})\n`);

    // ═══════════════════════════════════════════════════════════
    // 1) TODAS AS SESSÕES DE CONVÊNIO DO PERÍODO (qualquer status)
    // ═══════════════════════════════════════════════════════════
    const allSessions = await Session.find({
        date: { $gte: start, $lte: end },
        $or: [
            { paymentMethod: 'convenio' },
            { paymentOrigin: 'convenio' },
            { insuranceGuide: { $exists: true, $ne: null } },
            { insuranceProvider: { $exists: true, $ne: null, $ne: '' } }
        ]
    })
        .populate('patient', 'fullName phone')
        .populate('doctor', 'fullName specialty')
        .populate('insuranceGuide', 'number insurance specialty totalSessions usedSessions sessionValue status')
        .populate('appointmentId', 'insuranceProvider insuranceValue billingType paymentMethod insuranceGuide operationalStatus')
        .lean();

    // ═══════════════════════════════════════════════════════════
    // 2) AGENDAMENTOS DE CONVÊNIO SEM SESSION VINCULADA
    // ═══════════════════════════════════════════════════════════
    const allAppointments = await Appointment.find({
        date: { $gte: start, $lte: end },
        session: { $exists: false },
        $or: [
            { billingType: 'convenio' },
            { paymentMethod: 'convenio' },
            { insuranceProvider: { $exists: true, $ne: null, $ne: '' } },
            { insuranceGuide: { $exists: true, $ne: null } }
        ]
    })
        .populate('patient', 'fullName phone')
        .populate('doctor', 'fullName specialty')
        .populate('insuranceGuide', 'number insurance specialty totalSessions usedSessions sessionValue status')
        .lean();

    // Cruzar informações de lote e payment
    const sessionIds = allSessions.map(s => String(s._id));
    const batchInfo = await findBatchInfo(sessionIds);
    const paymentInfo = await findPaymentInfo(sessionIds);

    // Normalizar em itens comuns
    const normalizeSession = (s) => {
        const guide = s.insuranceGuide;
        const appt = s.appointmentId;
        const providerCandidates = [
            s.insuranceProvider,
            guide?.insurance,
            appt?.insuranceProvider,
            appt?.insurance?.provider,
            paymentInfo[String(s._id)]?.[0]?.provider,
            batchInfo[String(s._id)]?.[0]?.provider
        ];
        const provider = normalizeProvider(providerCandidates.find(p => p && String(p).trim()));

        return {
            type: 'session',
            date: s.date,
            patient: s.patient,
            doctor: s.doctor,
            specialty: s.sessionType || s.serviceType || s.specialty || guide?.specialty,
            value: s.sessionValue ?? 0,
            guide,
            provider,
            sessionId: String(s._id),
            appointmentId: appt ? String(appt._id) : null,
            paymentMethod: s.paymentMethod,
            paymentOrigin: s.paymentOrigin,
            batchInfo: batchInfo[String(s._id)] || [],
            paymentInfo: paymentInfo[String(s._id)] || [],
            operationalStatus: s.status
        };
    };

    const normalizeAppointment = (a) => {
        const guide = a.insuranceGuide;
        const providerCandidates = [
            a.insuranceProvider,
            guide?.insurance,
            a.insurance?.provider
        ];
        const provider = normalizeProvider(providerCandidates.find(p => p && String(p).trim()));

        return {
            type: 'appointment',
            date: a.date,
            patient: a.patient,
            doctor: a.doctor,
            specialty: a.sessionType || a.specialty || guide?.specialty,
            value: a.insuranceValue ?? a.sessionValue ?? 0,
            guide,
            provider,
            sessionId: null,
            appointmentId: String(a._id),
            paymentMethod: a.paymentMethod,
            paymentOrigin: a.paymentOrigin,
            batchInfo: [],
            paymentInfo: [],
            operationalStatus: a.operationalStatus
        };
    };

    const allItems = [
        ...allSessions.map(normalizeSession),
        ...allAppointments.map(normalizeAppointment)
    ];

    allItems.sort((a, b) => {
        const da = a.date ? moment(a.date).tz(TIMEZONE).format('YYYYMMDD') : '00000000';
        const db = b.date ? moment(b.date).tz(TIMEZONE).format('YYYYMMDD') : '00000000';
        if (da !== db) return da.localeCompare(db);
        const pa = a.patient?.fullName || '';
        const pb = b.patient?.fullName || '';
        return pa.localeCompare(pb);
    });

    const realizados = allItems.filter(i => i.operationalStatus === 'completed');
    const outros = allItems.filter(i => i.operationalStatus !== 'completed');

    const porConvenioRealizados = groupByConvenioPatientDay(realizados);
    const porConvenioOutros = groupByConvenioPatientDay(outros);

    // ═══════════════════════════════════════════════════════════
    // 3) MONTAR RELATÓRIO EM TEXTO
    // ═══════════════════════════════════════════════════════════
    const lines = [];
    const sep = '═'.repeat(100);
    const line = '─'.repeat(100);

    lines.push(sep);
    lines.push(`  RELATÓRIO DE CONVÊNIOS — ${monthStart.format('MM/YYYY')}`);
    lines.push(`  Gerado em: ${fmtDateTime(new Date())}`);
    lines.push(sep);
    lines.push('');

    const totalRealizadosSessoes = realizados.length;
    const totalRealizadosValor = realizados.reduce((s, i) => s + (i.value ?? 0), 0);
    const totalOutrosSessoes = outros.length;
    const totalOutrosValor = outros.reduce((s, i) => s + (i.value ?? 0), 0);
    const totalGeralSessoes = allItems.length;
    const totalGeralValor = allItems.reduce((s, i) => s + (i.value ?? 0), 0);

    lines.push('╔' + '═'.repeat(98) + '╗');
    lines.push(`║  RESUMO GERAL`.padEnd(98) + '║');
    lines.push('╠' + '═'.repeat(98) + '╣');
    lines.push(`║  ✅ Atendimentos realizados (completed): ${String(totalRealizadosSessoes).padStart(3)} registros  •  ${fmtBrl(totalRealizadosValor).padStart(12)}`.padEnd(98) + '║');
    lines.push(`║  📋 Outros registros (cancelados/agendados): ${String(totalOutrosSessoes).padStart(3)} registros  •  ${fmtBrl(totalOutrosValor).padStart(12)}`.padEnd(98) + '║');
    lines.push('╠' + '═'.repeat(98) + '╣');
    lines.push(`║  📊 TOTAL GERAL: ${String(totalGeralSessoes).padStart(3)} registros  •  ${fmtBrl(totalGeralValor).padStart(12)}`.padEnd(98) + '║');
    lines.push('╚' + '═'.repeat(98) + '╝');

    // Seção 1: Atendimentos Realizados
    renderConvenioSection(lines, porConvenioRealizados, 'ATENDIMENTOS REALIZADOS (STATUS = COMPLETED)');

    // Seção 2: Outros Registros
    renderConvenioSection(lines, porConvenioOutros, 'OUTROS REGISTROS DE CONVÊNIO NO MÊS');

    // Resumo por dia — todos os registros
    lines.push('');
    lines.push(sep);
    lines.push('  RESUMO POR DIA — TODOS OS REGISTROS DE CONVÊNIO');
    lines.push(sep);

    const porDia = {};
    for (const item of allItems) {
        const day = item.date ? moment(item.date).tz(TIMEZONE).format('DD/MM/YYYY') : '—';
        if (!porDia[day]) porDia[day] = { realizadas: 0, outras: 0, valor: 0 };
        if (item.operationalStatus === 'completed') {
            porDia[day].realizadas += 1;
        } else {
            porDia[day].outras += 1;
        }
        porDia[day].valor += item.value ?? 0;
    }

    lines.push(`  DATA            REALIZADAS   OUTRAS    TOTAL    VALOR`);
    lines.push(`  ${line}`);
    const sortedDays = Object.keys(porDia).sort((a, b) => {
        if (a === '—') return 1;
        if (b === '—') return -1;
        return moment(a, 'DD/MM/YYYY').tz(TIMEZONE).valueOf() - moment(b, 'DD/MM/YYYY').tz(TIMEZONE).valueOf();
    });
    for (const day of sortedDays) {
        const d = porDia[day];
        const total = d.realizadas + d.outras;
        lines.push(`  ${day.padEnd(15)} ${String(d.realizadas).padStart(6)} ${String(d.outras).padStart(10)} ${String(total).padStart(8)}  ${fmtBrl(d.valor).padStart(12)}`);
    }
    lines.push(`  ${'─'.repeat(60)}`);
    lines.push(`  TOTAL           ${String(totalRealizadosSessoes).padStart(6)} ${String(totalOutrosSessoes).padStart(10)} ${String(totalGeralSessoes).padStart(8)}  ${fmtBrl(totalGeralValor).padStart(12)}`);
    lines.push(sep);

    // Avisos
    const semConvenio = allItems.filter(i => i.provider === 'NÃO IDENTIFICADO');
    if (semConvenio.length > 0) {
        lines.push('');
        lines.push('╔' + '═'.repeat(98) + '╗');
        lines.push(`║  ⚠️  ATENÇÃO: ${semConvenio.length} registro(s) sem convênio identificado`.padEnd(98) + '║');
        lines.push('╚' + '═'.repeat(98) + '╝');
        for (const e of semConvenio) {
            lines.push(`     • ${fmtDate(e.date)}  ${e.patient?.fullName || '—'}  ${e.specialty}  ${fmtBrl(e.value)}  sessionId=${e.sessionId || '—'}  appointmentId=${e.appointmentId || '—'}`);
        }
    }

    const semPayment = realizados.filter(i => i.type === 'session' && (!i.paymentInfo || i.paymentInfo.length === 0));
    if (semPayment.length > 0) {
        lines.push('');
        lines.push('╔' + '═'.repeat(98) + '╗');
        lines.push(`║  ⚠️  ATENÇÃO: ${semPayment.length} sessão(ões) realizadas de convênio SEM payment vinculado`.padEnd(98) + '║');
        lines.push('╚' + '═'.repeat(98) + '╝');
        for (const e of semPayment) {
            lines.push(`     • ${fmtDate(e.date)}  ${e.patient?.fullName || '—'}  ${e.specialty}  ${fmtBrl(e.value)}  sessionId=${e.sessionId}`);
        }
    }

    lines.push('');
    lines.push('╔' + '═'.repeat(98) + '╗');
    lines.push(`║  ℹ️  NOTA SOBRE VALORES`.padEnd(98) + '║');
    lines.push('║  Este relatório contabiliza uma única vez cada sessão/atendimento real.          ║');
    lines.push('║  Relatórios de faturamento podem listar a mesma sessão em múltiplas linhas      ║');
    lines.push('║  (ex: pacote + lote), o que não representa atendimentos distintos.              ║');
    lines.push('╚' + '═'.repeat(98) + '╝');

    lines.push('');
    lines.push('✅ Relatório concluído.');

    const outputText = lines.join('\n');

    // ═══════════════════════════════════════════════════════════
    // 4) SALVAR EM ARQUIVO
    // ═══════════════════════════════════════════════════════════
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    const outputFile = join(OUTPUT_DIR, `relatorio_convenios_${year}_${String(month).padStart(2, '0')}.txt`);
    fs.writeFileSync(outputFile, outputText, 'utf8');

    console.log(outputText);
    console.log(`\n💾 Relatório salvo em: ${outputFile}`);
}

(async () => {
    const [,, yearArg, monthArg] = process.argv;
    const year = parseInt(yearArg || moment().year());
    const month = parseInt(monthArg || moment().month() + 1);

    if (!year || !month || month < 1 || month > 12) {
        console.error('❌ Uso: node scripts/relatorio-convenios-mensal.js <ano> <mes>');
        console.error('   Exemplo: node scripts/relatorio-convenios-mensal.js 2026 04');
        process.exit(1);
    }

    try {
        await connectDb();
        await runReport(year, month);
    } catch (err) {
        console.error('💥 Erro:', err.message);
        console.error(err.stack);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        console.log('\n🔌 Desconectado');
    }
})();
