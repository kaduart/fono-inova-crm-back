/**
 * ============================================================================
 * MIGRAÇÃO: Package tipo convenio → InsuranceGuide-only
 * ============================================================================
 *
 * O que faz:
 * 1. Sincroniza InsuranceGuide.usedSessions com sessões completed reais
 * 2. Arquiva Package legado (status: 'superseded') — PRESERVA histórico
 * 3. Remove Package de Patient.packages (para não listar no frontend)
 * 4. Reclassifica sessões anômalas (package_prepaid → convenio) se seguro
 * 5. Adiciona insuranceGuide em Payments que não têm
 *
 * Segurança financeira:
 * - NUNCA altera: amount, paidAt, financialDate, status de payments paid
 * - Só reclassifica sessão se: payment.status === 'pending' && amount === 0
 * - DRY-RUN por padrão (nada é salvo)
 * - Requer --apply para executar
 * - Gera log de rollback completo
 *
 * Uso:
 *   node scripts/migrate-convenio-packages-to-guides.js           (dry-run)
 *   node scripts/migrate-convenio-packages-to-guides.js --apply   (execução real)
 *   node scripts/migrate-convenio-packages-to-guides.js --apply --patient=ID (um paciente)
 * ============================================================================
 */

import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================================
// CONFIGURAÇÃO
// =============================================================================

const DRY_RUN = !process.argv.includes('--apply');
const TARGET_PATIENT_ID = process.argv.find(arg => arg.startsWith('--patient='))?.split('=')[1] || null;
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

const ROLLBACK_LOG_PATH = path.join(__dirname, '..', 'logs', `rollback-convenio-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

// =============================================================================
// HELPERS
// =============================================================================

function ensureLogsDir() {
    const logsDir = path.join(__dirname, '..', 'logs');
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
    }
}

function logRollback(entry) {
    ensureLogsDir();
    const existing = fs.existsSync(ROLLBACK_LOG_PATH) ? JSON.parse(fs.readFileSync(ROLLBACK_LOG_PATH, 'utf8')) : [];
    existing.push({
        timestamp: new Date().toISOString(),
        ...entry
    });
    fs.writeFileSync(ROLLBACK_LOG_PATH, JSON.stringify(existing, null, 2));
}

async function isSessionFinanciallyInert(session, payment) {
    if (!payment) return true;

    // Regras de segurança financeira
    const checks = {
        paymentAmountZero: payment.amount === 0,
        paymentStatusPending: payment.status === 'pending',
        paymentPaidAtNull: !payment.paidAt,
        paymentFinancialDateNull: !payment.financialDate,
        paymentNotCanceled: !payment.canceledAt
    };

    const allSafe = Object.values(checks).every(Boolean);

    if (!allSafe) {
        console.log(`      ⚠️  NÃO é financialmente inerte:`, checks);
    }

    return allSafe;
}

// =============================================================================
// MIGRAÇÃO POR PACIENTE
// =============================================================================

async function migratePatient(db, patient) {
    const results = {
        patientId: patient._id.toString(),
        patientName: patient.fullName,
        packagesProcessed: 0,
        guidesSynced: 0,
        sessionsReclassified: 0,
        sessionsSkipped: 0,
        paymentsUpdated: 0,
        packagesSuperseded: 0,
        packagesSkipped: 0,
        patientUpdated: false,
        errors: []
    };

    console.log(`\n👤 ${patient.fullName} (${patient._id})`);

    // 1. Buscar packages tipo convenio ativos
    const packages = await db.collection('packages').find({
        patient: patient._id,
        type: 'convenio',
        status: { $in: ['active', 'in-progress'] }
    }).toArray();

    if (packages.length === 0) {
        console.log('   ℹ️  Nenhum package convênio ativo para migrar');
        return results;
    }

    console.log(`   📦 Packages ativos encontrados: ${packages.length}`);

    for (const pkg of packages) {
        const packageId = pkg._id.toString();
        console.log(`   → Package ${packageId} (${pkg.totalSessions}sess, ${pkg.sessionsDone}done)`);

        try {
            // 2. Buscar InsuranceGuide vinculada
            const guide = await db.collection('insuranceguides').findOne({
                _id: pkg.insuranceGuide
            });

            if (!guide) {
                console.log(`      ⚠️  Sem InsuranceGuide vinculada — pulando`);
                results.packagesSkipped++;
                continue;
            }

            const guideId = guide._id;
            console.log(`      📋 Guia #${guide.number} (used: ${guide.usedSessions}/${guide.totalSessions})`);

            // 3. Contar sessões completed REAIS para esta guia
            const completedSessions = await db.collection('sessions').find({
                insuranceGuide: guideId,
                status: 'completed'
            }).toArray();

            const realUsed = completedSessions.length;
            console.log(`      ✅ Sessões completed reais: ${realUsed}`);

            // 3a. Sincronizar InsuranceGuide
            if (guide.usedSessions !== realUsed) {
                const oldUsed = guide.usedSessions;

                if (!DRY_RUN) {
                    await db.collection('insuranceguides').updateOne(
                        { _id: guideId },
                        { $set: { usedSessions: realUsed, updatedAt: new Date() } }
                    );
                    logRollback({
                        collection: 'insuranceguides',
                        id: guideId.toString(),
                        action: 'update_usedSessions',
                        oldValue: oldUsed,
                        newValue: realUsed
                    });
                }

                console.log(`      🔄 usedSessions: ${oldUsed} → ${realUsed}`);
                results.guidesSynced++;
            } else {
                console.log(`      ✓ usedSessions já está correto`);
            }

            // 3b. Verificar guideConsumed nas sessions
            for (const sess of completedSessions) {
                if (!sess.guideConsumed) {
                    console.log(`      🔄 Session ${sess._id}: guideConsumed false → true`);
                    if (!DRY_RUN) {
                        await db.collection('sessions').updateOne(
                            { _id: sess._id },
                            { $set: { guideConsumed: true } }
                        );
                        logRollback({
                            collection: 'sessions',
                            id: sess._id.toString(),
                            action: 'update_guideConsumed',
                            oldValue: false,
                            newValue: true
                        });
                    }
                }
            }

            // 4. Arquivar Package com migration marker
            if (pkg.status !== 'superseded') {
                const migrationMeta = {
                    status: 'superseded',
                    updatedAt: new Date(),
                    migratedToInsuranceGuide: true,
                    migratedAt: new Date(),
                    migrationVersion: 'v2',
                    legacyType: 'convenio',
                    supersededBy: 'insuranceGuide',
                    supersededEntityId: guideId
                };

                if (!DRY_RUN) {
                    await db.collection('packages').updateOne(
                        { _id: pkg._id },
                        { $set: migrationMeta }
                    );
                    logRollback({
                        collection: 'packages',
                        id: packageId,
                        action: 'update_status_and_marker',
                        oldValue: { status: pkg.status },
                        newValue: migrationMeta
                    });
                }
                console.log(`      📦 Status: ${pkg.status} → superseded + migration marker`);
                results.packagesSuperseded++;
            }

            // 5. Corrigir sessões anômalas (package_prepaid em convênio)
            const anomalousSessions = await db.collection('sessions').find({
                package: pkg._id,
                $or: [
                    { paymentOrigin: 'package_prepaid' },
                    { paymentMethod: 'package_prepaid' },
                    { paymentStatus: 'package_paid' }
                ]
            }).toArray();

            for (const sess of anomalousSessions) {
                const payment = sess.paymentId
                    ? await db.collection('payments').findOne({ _id: sess.paymentId })
                    : null;

                const safe = await isSessionFinanciallyInert(sess, payment);

                if (safe) {
                    const updates = {};
                    if (sess.paymentOrigin === 'package_prepaid') updates.paymentOrigin = 'convenio';
                    if (sess.paymentMethod === 'package_prepaid') updates.paymentMethod = 'convenio';
                    if (sess.paymentStatus === 'package_paid') updates.paymentStatus = 'pending_receipt';
                    if (sess.isPaid === true) updates.isPaid = false;
                    if (Object.keys(updates).length > 0) {
                        updates.updatedAt = new Date();

                        if (!DRY_RUN) {
                            await db.collection('sessions').updateOne(
                                { _id: sess._id },
                                { $set: updates }
                            );
                            logRollback({
                                collection: 'sessions',
                                id: sess._id.toString(),
                                action: 'reclassify_anomalous',
                                oldValues: {
                                    paymentOrigin: sess.paymentOrigin,
                                    paymentMethod: sess.paymentMethod,
                                    paymentStatus: sess.paymentStatus,
                                    isPaid: sess.isPaid
                                },
                                newValues: updates
                            });
                        }

                        console.log(`      🔧 Session ${sess._id.toString().slice(-6)} reclassificada:`, Object.keys(updates).join(', '));
                        results.sessionsReclassified++;
                    }
                } else {
                    console.log(`      ⛔ Session ${sess._id.toString().slice(-6)} NÃO reclassificada (risco financeiro)`);
                    results.sessionsSkipped++;
                }
            }

            // 6. Backfill insuranceGuide nos Appointments
            const appointmentsToBackfill = await db.collection('appointments').find({
                package: pkg._id,
                $or: [
                    { insuranceGuide: { $exists: false } },
                    { insuranceGuide: null }
                ]
            }).toArray();

            for (const apt of appointmentsToBackfill) {
                if (!DRY_RUN) {
                    await db.collection('appointments').updateOne(
                        { _id: apt._id },
                        { $set: { insuranceGuide: guideId, updatedAt: new Date() } }
                    );
                    logRollback({
                        collection: 'appointments',
                        id: apt._id.toString(),
                        action: 'add_insuranceGuide',
                        oldValue: apt.insuranceGuide || null,
                        newValue: guideId.toString()
                    });
                }
            }
            if (appointmentsToBackfill.length > 0) {
                console.log(`      📅 ${appointmentsToBackfill.length} appointment(s) backfill com insuranceGuide`);
            }

            // 7. Atualizar Payments: adicionar insuranceGuide se não tiver
            const payments = await db.collection('payments').find({
                package: pkg._id,
                $or: [
                    { insuranceGuide: { $exists: false } },
                    { insuranceGuide: null }
                ]
            }).toArray();

            for (const pay of payments) {
                if (!DRY_RUN) {
                    await db.collection('payments').updateOne(
                        { _id: pay._id },
                        { $set: { insuranceGuide: guideId, updatedAt: new Date() } }
                    );
                    logRollback({
                        collection: 'payments',
                        id: pay._id.toString(),
                        action: 'add_insuranceGuide',
                        oldValue: pay.insuranceGuide || null,
                        newValue: guideId.toString()
                    });
                }
                results.paymentsUpdated++;
            }
            if (payments.length > 0) {
                console.log(`      💰 ${payments.length} payment(s) atualizado(s) com insuranceGuide`);
            }

            results.packagesProcessed++;

        } catch (err) {
            console.error(`      ❌ Erro no package ${packageId}:`, err.message);
            results.errors.push({ packageId, error: err.message });
        }
    }

    // 7. Remover packages superseded do Patient.packages
    const patientHasSuperseded = await db.collection('packages').countDocuments({
        patient: patient._id,
        status: 'superseded',
        type: 'convenio'
    });

    if (patientHasSuperseded > 0) {
        const supersededIds = (await db.collection('packages').find({
            patient: patient._id,
            status: 'superseded',
            type: 'convenio'
        }).toArray()).map(p => p._id);

        const oldPackages = patient.packages || [];
        const newPackages = oldPackages.filter(p =>
            !supersededIds.some(s => s.toString() === p.toString())
        );

        if (oldPackages.length !== newPackages.length) {
            if (!DRY_RUN) {
                await db.collection('patients').updateOne(
                    { _id: patient._id },
                    { $set: { packages: newPackages, updatedAt: new Date() } }
                );
                logRollback({
                    collection: 'patients',
                    id: patient._id.toString(),
                    action: 'remove_superseded_packages',
                    oldPackages: oldPackages.map(p => p.toString()),
                    newPackages: newPackages.map(p => p.toString())
                });
            }
            console.log(`      👤 Patient.packages: removidos ${oldPackages.length - newPackages.length} package(s) superseded`);
            results.patientUpdated = true;
        }
    }

    return results;
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
    if (!MONGO_URI) {
        console.error('❌ MONGO_URI não encontrado no .env');
        process.exit(1);
    }

    await mongoose.connect(MONGO_URI);
    const db = mongoose.connection.db;

    console.log('='.repeat(70));
    console.log('MIGRAÇÃO: Package tipo convenio → InsuranceGuide-only');
    console.log('='.repeat(70));
    console.log(`Modo: ${DRY_RUN ? '🔍 DRY-RUN (nada será salvo)' : '⚠️  EXECUÇÃO REAL'}`);
    if (TARGET_PATIENT_ID) {
        console.log(`Filtro: apenas patientId=${TARGET_PATIENT_ID}`);
    }
    console.log('='.repeat(70));

    // Buscar pacientes com packages convênio ativos
    const query = TARGET_PATIENT_ID
        ? { _id: new mongoose.Types.ObjectId(TARGET_PATIENT_ID) }
        : {};

    const patientIdsWithPackages = await db.collection('packages').distinct('patient', {
        type: 'convenio',
        status: { $in: ['active', 'in-progress'] }
    });

    let patients = [];
    if (TARGET_PATIENT_ID) {
        const p = await db.collection('patients').findOne(query);
        if (p) patients.push(p);
    } else {
        patients = await db.collection('patients').find({
            _id: { $in: patientIdsWithPackages }
        }).toArray();
    }

    console.log(`\n📋 Pacientes encontrados: ${patients.length}`);

    const globalResults = {
        mode: DRY_RUN ? 'DRY-RUN' : 'APPLY',
        timestamp: new Date().toISOString(),
        totalPatients: patients.length,
        patients: [],
        totals: {
            packagesProcessed: 0,
            guidesSynced: 0,
            sessionsReclassified: 0,
            sessionsSkipped: 0,
            paymentsUpdated: 0,
            packagesSuperseded: 0,
            patientsUpdated: 0,
            errors: 0
        }
    };

    for (const patient of patients) {
        const result = await migratePatient(db, patient);
        globalResults.patients.push(result);

        globalResults.totals.packagesProcessed += result.packagesProcessed;
        globalResults.totals.guidesSynced += result.guidesSynced;
        globalResults.totals.sessionsReclassified += result.sessionsReclassified;
        globalResults.totals.sessionsSkipped += result.sessionsSkipped;
        globalResults.totals.paymentsUpdated += result.paymentsUpdated;
        globalResults.totals.packagesSuperseded += result.packagesSuperseded;
        if (result.patientUpdated) globalResults.totals.patientsUpdated++;
        globalResults.totals.errors += result.errors.length;
    }

    // Resumo
    console.log('\n' + '='.repeat(70));
    console.log('RESUMO GLOBAL');
    console.log('='.repeat(70));
    console.log(`Pacientes processados:        ${globalResults.totals.packagesProcessed > 0 ? patients.length : 0}`);
    console.log(`Packages processados:         ${globalResults.totals.packagesProcessed}`);
    console.log(`Packages arquivados:          ${globalResults.totals.packagesSuperseded}`);
    console.log(`Guias sincronizadas:          ${globalResults.totals.guidesSynced}`);
    console.log(`Sessions reclassificadas:     ${globalResults.totals.sessionsReclassified}`);
    console.log(`Sessions puladas (risco):     ${globalResults.totals.sessionsSkipped}`);
    console.log(`Payments atualizados:         ${globalResults.totals.paymentsUpdated}`);
    console.log(`Patients atualizados:         ${globalResults.totals.patientsUpdated}`);
    console.log(`Erros:                        ${globalResults.totals.errors}`);
    console.log('='.repeat(70));

    if (DRY_RUN) {
        console.log('\n💡 Para executar de verdade, rode com: --apply');
        if (TARGET_PATIENT_ID) {
            console.log(`   node scripts/migrate-convenio-packages-to-guides.js --apply --patient=${TARGET_PATIENT_ID}`);
        } else {
            console.log('   node scripts/migrate-convenio-packages-to-guides.js --apply');
        }
    } else {
        console.log(`\n📝 Rollback log salvo em: ${ROLLBACK_LOG_PATH}`);
        console.log('   Para reverter, use os dados do log JSON.');
    }

    // Salvar resumo
    ensureLogsDir();
    const summaryPath = path.join(__dirname, '..', 'logs', `migrate-convenio-summary-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(summaryPath, JSON.stringify(globalResults, null, 2));
    console.log(`📝 Resumo salvo em: ${summaryPath}`);

    await mongoose.disconnect();
}

main().catch(err => {
    console.error('❌ Erro fatal:', err);
    process.exit(1);
});
