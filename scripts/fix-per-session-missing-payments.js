/**
 * Correção pontual: appointments per_session completados sem Payment no ledger
 *
 * O bug em appointment.js checava `paymentType === 'per-session'` (hífen)
 * mas o campo correto é `package.model === 'per_session'` (underscore).
 * Resultado: nenhum Payment era criado → TruthLayer mostrava como pendente.
 *
 * Roda: node scripts/fix-per-session-missing-payments.js [--date=2026-04-29] [--dry-run]
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import moment from 'moment-timezone';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!MONGO_URI) { console.error('❌ MONGODB_URI não configurada'); process.exit(1); }

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const dateArg = args.find(a => a.startsWith('--date='))?.split('=')[1];
const TARGET_DATE = dateArg || moment.tz('America/Sao_Paulo').format('YYYY-MM-DD');

async function main() {
    await mongoose.connect(MONGO_URI);
    console.log(`🔌 Conectado: ${mongoose.connection.db.databaseName}`);
    console.log(`📅 Data alvo: ${TARGET_DATE}  |  DRY_RUN: ${DRY_RUN}\n`);

    const Payment = (await import('../models/Payment.js')).default;
    const Session = (await import('../models/Session.js')).default;

    const start = moment.tz(TARGET_DATE, 'America/Sao_Paulo').startOf('day').utc().toDate();
    const end   = moment.tz(TARGET_DATE, 'America/Sao_Paulo').endOf('day').utc().toDate();

    // Busca Sessions completadas do dia com pacote (mesma fonte que calculateProduction)
    const sessions = await Session.find({
        date: { $gte: start, $lte: end },
        status: 'completed',
        package: { $exists: true, $ne: null },
        addedToBalance: { $ne: true }
    })
    .populate('package', 'model paymentType sessionValue totalValue totalSessions')
    .populate('patient', 'fullName phone')
    .populate('doctor', 'fullName')
    .lean();

    console.log(`🔍 Sessions completadas com pacote: ${sessions.length}`);

    const affected = [];

    for (const s of sessions) {
        const pkg = s.package;
        if (!pkg) continue;

        const isPerSession = pkg.model === 'per_session' ||
                             pkg.paymentType === 'per-session' ||
                             pkg.paymentType === 'per_session';
        if (!isPerSession) continue;

        // Verifica se já existe Payment no ledger (por session OU por appointment)
        const existingPayment = await Payment.findOne({
            $or: [
                { session: s._id },
                ...(s.appointmentId ? [{ appointment: s.appointmentId }] : [])
            ],
            status: { $in: ['paid', 'pending'] }
        }).lean();

        const sessionValue = s.sessionValue ||
                             pkg.sessionValue ||
                             (pkg.totalValue && pkg.totalSessions
                                 ? Math.round(pkg.totalValue / pkg.totalSessions)
                                 : 0);

        affected.push({ s, pkg, existingPayment, sessionValue });
    }

    console.log(`\n⚠️  Per_session SEM Payment no ledger: ${affected.filter(a => !a.existingPayment).length}`);
    console.log(`✅  Per_session JÁ COM Payment: ${affected.filter(a => !!a.existingPayment).length}\n`);

    let fixed = 0;
    let skipped = 0;

    for (const { s, existingPayment, sessionValue } of affected) {
        const patientName = s.patient?.fullName || '?';
        const hora = s.time || '';

        if (existingPayment) {
            console.log(`  ✅ SKIP  [${hora}] ${patientName} — Payment já existe (${existingPayment.status})`);
            skipped++;
            continue;
        }

        console.log(`  🔧 FIX   [${hora}] ${patientName} — criando Payment R$${sessionValue} (session: ${s._id})`);

        if (!DRY_RUN) {
            const payment = await Payment.create({
                patient:       s.patient?._id || s.patient,
                doctor:        s.doctor?._id  || s.doctor,
                appointment:   s.appointmentId || null,
                session:       s._id,
                package:       s.package?._id || s.package,
                serviceType:   'package_session',
                amount:        sessionValue,
                paymentMethod: s.paymentMethod || 'pix',
                status:        'paid',
                paidAt:        new Date(),
                kind:          'session_payment',
                serviceDate:   s.date,
                paymentDate:   TARGET_DATE,
                confirmedAt:   new Date(),
                paymentOrigin: 'fix_per_session_missing_payment',
                notes:         `[FIX] Correção automática — bug isPerSession check (${TARGET_DATE})`,
                createdAt:     new Date(),
                updatedAt:     new Date()
            });

            await Session.updateOne(
                { _id: s._id },
                { $set: { isPaid: true, paymentStatus: 'paid', paymentId: payment._id, updatedAt: new Date() } }
            );

            console.log(`       → Payment criado: ${payment._id}`);
            fixed++;
        } else {
            console.log(`       → [DRY-RUN] seria criado Payment R$${sessionValue}`);
            fixed++;
        }
    }

    console.log(`\n📊 Resultado: ${fixed} corrigidos, ${skipped} já OK`);
    if (DRY_RUN) console.log('ℹ️  Modo DRY-RUN — nenhuma alteração feita. Rode sem --dry-run para aplicar.');

    await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
