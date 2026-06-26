/**
 * 🔧 BACKFILL CATEGORIA A — Session.sessionValue deve espelhar InsuranceGuide.sessionValue
 *
 * Regra de negócio:
 *   InsuranceGuide.sessionValue = fonte oficial do valor da sessão.
 *   Session.sessionValue deve sempre espelhar InsuranceGuide.sessionValue.
 *
 * Este script corrige APENAS sessões onde há evidência clara de erro:
 *   - Session.status = 'completed'
 *   - Session vinculada a InsuranceGuide
 *   - InsuranceGuide.sessionValue === Payment.amount
 *   - Session.sessionValue !== InsuranceGuide.sessionValue
 *   - Sem glosa ou retorno parcial no lote
 *
 * Sessões onde Guide != Payment (Categoria B) NÃO são alteradas automaticamente.
 *
 * Uso:
 *   node scripts/backfill-session-value-categoria-a.js dry-run   (padrão)
 *   node scripts/backfill-session-value-categoria-a.js apply
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

const TIMEZONE = 'America/Sao_Paulo';

async function connectDb() {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    await mongoose.connect(uri);
    console.log(`🔗 Conectado: ${uri.split('@').pop()?.split('/').shift()}\n`);
}

function fmtBrl(v) {
    if (v == null) return '—';
    return `R$ ${Number(v).toFixed(2).replace('.', ',')}`;
}

async function run() {
    const mode = process.argv[2] || 'dry-run';
    const apply = mode === 'apply';

    console.log('🔍 Buscando sessões de convênio completadas...\n');

    const sessions = await Session.find({
        status: 'completed',
        insuranceGuide: { $exists: true, $ne: null },
        $or: [
            { paymentMethod: 'convenio' },
            { paymentOrigin: 'convenio' }
        ]
    }).populate('patient', 'fullName')
      .populate('insuranceGuide', 'number insurance sessionValue')
      .lean();

    const sessionIds = sessions.map(s => String(s._id));

    const payments = await Payment.find({
        $or: [
            { session: { $in: sessionIds.map(id => new mongoose.Types.ObjectId(id)) } },
            { sessions: { $in: sessionIds.map(id => new mongoose.Types.ObjectId(id)) } }
        ],
        amount: { $gt: 0 }
    }).lean();

    const batches = await InsuranceBatch.find({
        'sessions.session': { $in: sessionIds.map(id => new mongoose.Types.ObjectId(id)) }
    }).lean();
    const batchSessionBySession = {};
    for (const batch of batches) {
        for (const bs of batch.sessions || []) {
            if (bs.session) batchSessionBySession[String(bs.session)] = bs;
        }
    }

    const toFix = [];

    for (const s of sessions) {
        const sessionId = String(s._id);
        const guideValue = s.insuranceGuide?.sessionValue;
        if (guideValue == null || guideValue <= 0) continue;

        const relatedPayments = payments.filter(p => {
            if (p.session && String(p.session) === sessionId) return true;
            if (Array.isArray(p.sessions) && p.sessions.some(id => String(id) === sessionId)) return true;
            return false;
        });

        const payment = relatedPayments.find(p => p.amount > 0) || relatedPayments[0];
        if (!payment || payment.amount <= 0) continue;

        const batchSession = batchSessionBySession[sessionId];
        const hasGlosa = (batchSession?.glosaAmount || 0) > 0;
        const hasPartialReturn = (batchSession?.returnAmount || 0) > 0 && batchSession.returnAmount < payment.amount;

        // Categoria A: Guide == Payment && Session diverge && sem glosa/retorno parcial
        if (guideValue === payment.amount && s.sessionValue !== guideValue && !hasGlosa && !hasPartialReturn) {
            toFix.push({
                sessionId,
                data: s.date ? moment(s.date).tz(TIMEZONE).format('DD/MM/YYYY') : '—',
                mesAno: s.date ? moment(s.date).tz(TIMEZONE).format('MM/YYYY') : '—',
                paciente: s.patient?.fullName || '—',
                guia: s.insuranceGuide?.number || '—',
                convenio: s.insuranceGuide?.insurance || '—',
                currentValue: s.sessionValue,
                guideValue,
                paymentAmount: payment.amount,
                paymentId: payment._id.toString()
            });
        }
    }

    console.log(`📊 Sessões analisadas: ${sessions.length}`);
    console.log(`🛠️  Modo: ${apply ? 'APLICAR ALTERAÇÕES' : 'DRY-RUN (simulação)'}`);
    console.log(`⚠️  Correções pendentes (Categoria A): ${toFix.length}`);
    console.log('');

    if (toFix.length === 0) {
        console.log('✅ Nenhuma sessão elegível para correção automática.');
        await mongoose.disconnect();
        return;
    }

    for (const item of toFix) {
        console.log(`• ${item.data} | ${item.mesAno} | ${item.paciente}`);
        console.log(`  Session: ${item.sessionId.slice(-6)} | Guia: ${item.guia} (${item.convenio})`);
        console.log(`  SessionValue atual: ${fmtBrl(item.currentValue)}`);
        console.log(`  GuideValue:         ${fmtBrl(item.guideValue)}`);
        console.log(`  PaymentAmount:      ${fmtBrl(item.paymentAmount)}`);
        console.log(`  → Novo valor:       ${fmtBrl(item.guideValue)}`);
        console.log('');
    }

    if (!apply) {
        console.log(`ℹ️  Para aplicar as correções, rode:`);
        console.log(`   node scripts/backfill-session-value-categoria-a.js apply`);
        await mongoose.disconnect();
        return;
    }

    // Backup
    const backupFile = join(__dirname, '..', 'auditoria-output', `backup_sessions_categoria_a_pre_backfill_${moment().tz(TIMEZONE).format('YYYYMMDD_HHmm')}.json`);
    fs.writeFileSync(backupFile, JSON.stringify(toFix, null, 2));
    console.log(`💾 Backup salvo: ${backupFile}`);

    console.log('\n🚀 Aplicando correções...');
    let updated = 0;
    for (const item of toFix) {
        const result = await Session.updateOne(
            { _id: new mongoose.Types.ObjectId(item.sessionId) },
            { $set: { sessionValue: item.guideValue } }
        );
        if (result.modifiedCount > 0) {
            updated++;
            console.log(`   ✅ ${item.sessionId.slice(-6)} corrigido para ${fmtBrl(item.guideValue)}`);
        }
    }

    console.log(`\n✅ ${updated} sessão(ões) corrigida(s).`);
    await mongoose.disconnect();
}

connectDb().then(run).catch(err => {
    console.error('💥 Erro:', err.message);
    console.error(err.stack);
    process.exit(1);
});
