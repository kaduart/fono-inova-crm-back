/**
 * 📋 AUDITORIA DE DIVERGÊNCIAS — Guia vs Session vs Payment
 *
 * Lista todas as sessões de convênio completed e classifica as divergências:
 *
 *   Categoria A: Guide == Payment && Session diverge  → corrigível automaticamente
 *   Categoria B: Guide != Payment                     → revisão manual
 *   Categoria C: Payment com glosa/retorno parcial    → nunca corrigir automaticamente
 *
 * Uso: node scripts/auditoria-divergencias-convenio.js
 */

import mongoose from 'mongoose';
import moment from 'moment-timezone';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env') });

import '../models/index.js';
import InsuranceBatch from '../models/InsuranceBatch.js';

const Session = mongoose.model('Session');
const Payment = mongoose.model('Payment');
const InsuranceGuide = mongoose.model('InsuranceGuide');

const TIMEZONE = 'America/Sao_Paulo';
const OUTPUT_DIR = join(__dirname, '..', 'auditoria-output');

function fmtBrl(v) {
    if (v == null) return '—';
    return `R$ ${Number(v).toFixed(2).replace('.', ',')}`;
}

function fmtDate(d) {
    if (!d) return '—';
    return moment(d).tz(TIMEZONE).format('DD/MM/YYYY');
}

async function connectDb() {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    await mongoose.connect(uri);
    console.log(`🔗 Conectado: ${uri.split('@').pop()?.split('/').shift()}\n`);
}

async function run() {
    console.log('🔍 Buscando sessões de convênio completadas...\n');

    const sessions = await Session.find({
        status: 'completed',
        $or: [
            { paymentMethod: 'convenio' },
            { paymentOrigin: 'convenio' },
            { insuranceGuide: { $exists: true, $ne: null } }
        ]
    }).populate('patient', 'fullName')
      .populate('doctor', 'fullName specialty')
      .populate('insuranceGuide', 'number insurance sessionValue status')
      .lean();

    console.log(`💾 Total de sessões encontradas: ${sessions.length}\n`);

    const sessionIds = sessions.map(s => String(s._id));

    // Busca payments vinculados
    const payments = await Payment.find({
        $or: [
            { session: { $in: sessionIds.map(id => new mongoose.Types.ObjectId(id)) } },
            { sessions: { $in: sessionIds.map(id => new mongoose.Types.ObjectId(id)) } }
        ]
    }).lean();

    // Busca lotes vinculados
    const batches = await InsuranceBatch.find({
        'sessions.session': { $in: sessionIds.map(id => new mongoose.Types.ObjectId(id)) }
    }).lean();
    const batchSessionBySession = {};
    for (const batch of batches) {
        for (const bs of batch.sessions || []) {
            if (bs.session) batchSessionBySession[String(bs.session)] = { batch, session: bs };
        }
    }

    const categoriaA = [];
    const categoriaB = [];
    const categoriaC = [];
    const consistentes = [];

    for (const s of sessions) {
        const sessionId = String(s._id);
        const guide = s.insuranceGuide;
        const guideValue = guide?.sessionValue ?? null;

        const relatedPayments = payments.filter(p => {
            if (p.session && String(p.session) === sessionId) return true;
            if (Array.isArray(p.sessions) && p.sessions.some(id => String(id) === sessionId)) return true;
            return false;
        });

        const payment = relatedPayments.find(p => p.amount > 0) || relatedPayments[0];
        const paymentAmount = payment?.amount ?? null;

        const batchInfo = batchSessionBySession[sessionId];
        const batchSession = batchInfo?.session;
        const batch = batchInfo?.batch;
        const glosaAmount = batchSession?.glosaAmount || 0;
        const returnAmount = batchSession?.returnAmount || 0;
        const hasGlosa = glosaAmount > 0;
        const hasPartialReturn = returnAmount > 0 && returnAmount < (paymentAmount || 0);

        const item = {
            sessionId,
            data: fmtDate(s.date),
            mesAno: s.date ? moment(s.date).tz(TIMEZONE).format('MM/YYYY') : '—',
            paciente: s.patient?.fullName || '—',
            profissional: s.doctor?.fullName || '—',
            especialidade: s.sessionType || s.doctor?.specialty || '—',
            guia: guide?.number || '—',
            convenio: guide?.insurance || '—',
            guideValue,
            sessionValue: s.sessionValue,
            paymentAmount,
            paymentId: payment?._id?.toString() || '—',
            hasGlosa,
            hasPartialReturn,
            batchNumber: batch?.batchNumber || '—',
            batchStatus: batch?.status || '—',
            loteEnviado: !!batch?.sentDate,
            loteRecebido: batch?.status === 'received'
        };

        // Categoria C: glosa ou retorno parcial → nunca automático
        if (hasGlosa || hasPartialReturn) {
            categoriaC.push(item);
            continue;
        }

        // Sem guide ou sem payment → não classificável
        if (guideValue == null || paymentAmount == null) {
            categoriaB.push(item);
            continue;
        }

        // Categoria A: guide == payment e session diverge
        if (guideValue === paymentAmount && s.sessionValue !== guideValue) {
            categoriaA.push(item);
            continue;
        }

        // Categoria B: guide != payment
        if (guideValue !== paymentAmount) {
            categoriaB.push(item);
            continue;
        }

        // Consistente
        consistentes.push(item);
    }

    // Ordenar por data
    const sortByDate = (a, b) => {
        const da = a.data === '—' ? '' : moment(a.data, 'DD/MM/YYYY').tz(TIMEZONE).valueOf();
        const db = b.data === '—' ? '' : moment(b.data, 'DD/MM/YYYY').tz(TIMEZONE).valueOf();
        return da - db;
    };
    categoriaA.sort(sortByDate);
    categoriaB.sort(sortByDate);
    categoriaC.sort(sortByDate);

    // Montar relatório
    const lines = [];
    const sep = '═'.repeat(120);
    const line = '─'.repeat(120);

    lines.push(sep);
    lines.push('  AUDITORIA DE DIVERGÊNCIAS — GUIA vs SESSION vs PAYMENT');
    lines.push(`  Gerado em: ${moment().tz(TIMEZONE).format('DD/MM/YYYY HH:mm')}`);
    lines.push(sep);
    lines.push('');

    lines.push('╔' + '═'.repeat(118) + '╗');
    lines.push(`║  RESUMO`.padEnd(118) + '║');
    lines.push('╠' + '═'.repeat(118) + '╣');
    lines.push(`║  Total de sessões analisadas:     ${String(sessions.length).padStart(6)}`.padEnd(118) + '║');
    lines.push(`║  Consistentes:                    ${String(consistentes.length).padStart(6)}`.padEnd(118) + '║');
    lines.push(`║  Categoria A (corrigível auto):   ${String(categoriaA.length).padStart(6)}`.padEnd(118) + '║');
    lines.push(`║  Categoria B (revisão manual):    ${String(categoriaB.length).padStart(6)}`.padEnd(118) + '║');
    lines.push(`║  Categoria C (glosa/parcial):     ${String(categoriaC.length).padStart(6)}`.padEnd(118) + '║');
    lines.push('╚' + '═'.repeat(118) + '╝');
    lines.push('');

    const renderCategoria = (titulo, itens, descricao) => {
        lines.push('▓'.repeat(120));
        lines.push(`  ${titulo}`);
        lines.push(`  ${descricao}`);
        lines.push(`  ${itens.length} registro(s)`);
        lines.push('▓'.repeat(120));
        lines.push('');

        if (itens.length === 0) {
            lines.push('  ✅ Nenhum registro nesta categoria.');
            lines.push('');
            return;
        }

        lines.push(`  DATA       MÊS     PACIENTE                    GUIA            CONVÊNIO           GUIA         SESSION      PAYMENT      DIFERENÇA    LOTE`);
        lines.push(`  ${line}`);

        for (const i of itens) {
            const diffGuideSession = (i.guideValue ?? 0) - (i.sessionValue ?? 0);
            const diffGuidePayment = (i.guideValue ?? 0) - (i.paymentAmount ?? 0);
            const diffStr = `G-S:${diffGuideSession >= 0 ? '+' : ''}${diffGuideSession} G-P:${diffGuidePayment >= 0 ? '+' : ''}${diffGuidePayment}`;
            lines.push(`  ${i.data.padEnd(10)} ${i.mesAno.padEnd(7)} ${i.paciente.substring(0, 25).padEnd(25)} ${i.guia.padEnd(14)} ${i.convenio.padEnd(17)} ${fmtBrl(i.guideValue).padStart(11)} ${fmtBrl(i.sessionValue).padStart(11)} ${fmtBrl(i.paymentAmount).padStart(11)} ${diffStr.padStart(20)} ${i.batchNumber.substring(0, 12).padEnd(12)}`);
        }
        lines.push('');
    };

    renderCategoria('CATEGORIA A — CORRIGÍVEL AUTOMATICAMENTE', categoriaA, 'Guide == Payment && Session diverge da guia');
    renderCategoria('CATEGORIA B — REVISÃO MANUAL', categoriaB, 'Guide != Payment (ambiguidade sobre qual valor está correto)');
    renderCategoria('CATEGORIA C — NUNCA CORRIGIR AUTOMATICAMENTE', categoriaC, 'Payment com glosa ou retorno parcial');

    // Detalhamento por categoria
    lines.push(sep);
    lines.push('  DETALHAMENTO COMPLETO');
    lines.push(sep);

    const renderDetalhes = (titulo, itens) => {
        lines.push('');
        lines.push(`  ${titulo} (${itens.length})`);
        lines.push(`  ${line}`);
        for (const i of itens) {
            lines.push(`  • ${i.data} | ${i.paciente} | ${i.especialidade}`);
            lines.push(`    Session:  ${i.sessionId}`);
            lines.push(`    Guia:     ${i.guia} (${i.convenio})`);
            lines.push(`    Guide$    ${fmtBrl(i.guideValue)} | Session$ ${fmtBrl(i.sessionValue)} | Payment$ ${fmtBrl(i.paymentAmount)}`);
            lines.push(`    Payment:  ${i.paymentId}`);
            lines.push(`    Lote:     ${i.batchNumber} [${i.batchStatus}] | enviado:${i.loteEnviado ? 'sim' : 'nao'} | recebido:${i.loteRecebido ? 'sim' : 'nao'}`);
            if (i.hasGlosa) lines.push(`    ⚠️  Glosa: ${fmtBrl(i.glosaAmount || 0)}`);
            if (i.hasPartialReturn) lines.push(`    ⚠️  Retorno parcial: ${fmtBrl(i.returnAmount || 0)}`);
        }
    };

    renderDetalhes('CATEGORIA A', categoriaA);
    renderDetalhes('CATEGORIA B', categoriaB);
    renderDetalhes('CATEGORIA C', categoriaC);

    lines.push('');
    lines.push(sep);
    lines.push('  INVARIANTE DE DOMÍNIO');
    lines.push(sep);
    lines.push('  Convênio:');
    lines.push('    InsuranceGuide.sessionValue = fonte oficial do valor da sessão.');
    lines.push('    Session.sessionValue deve sempre espelhar InsuranceGuide.sessionValue.');
    lines.push('    Payment.amount representa o valor financeiro faturado/recebido e pode divergir');
    lines.push('    em casos de glosa, pagamento parcial ou ajustes financeiros.');
    lines.push(sep);

    const outputText = lines.join('\n');

    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    const outputFile = join(OUTPUT_DIR, `auditoria_divergencias_convenio_${moment().tz(TIMEZONE).format('YYYYMMDD_HHmm')}.txt`);
    fs.writeFileSync(outputFile, outputText, 'utf8');

    console.log(outputText);
    console.log(`\n💾 Relatório salvo em: ${outputFile}`);

    await mongoose.disconnect();
}

connectDb().then(run).catch(err => {
    console.error('💥 Erro:', err.message);
    console.error(err.stack);
    process.exit(1);
});
