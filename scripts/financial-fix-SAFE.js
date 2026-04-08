#!/usr/bin/env node
/**
 * ============================================================================
 * FINANCIAL SYSTEM FIX - VERSÃO SEGURA (CIRÚRGICA)
 * ============================================================================
 * 
 * ⚠️  REGRAS DE OURO:
 * 1. NUNCA criar payment automaticamente
 * 2. NUNCA assumir que "paid sem payment" é erro (pode ser pacote/convenio)
 * 3. SEMPRE classificar antes de agir
 * 4. SEMPRE dry-run primeiro
 * 5. SEMPRE fazer backup antes de --apply
 * 
 * Uso: 
 *   node financial-fix-SAFE.js --analyze     # Análise detalhada
 *   node financial-fix-SAFE.js --dry-run     # Simulação
 *   node financial-fix-SAFE.js --apply       # EXECUÇÃO REAL (cuidado!)
 * ============================================================================
 */

import mongoose from 'mongoose';
import moment from 'moment-timezone';
import { config } from 'dotenv';
import fs from 'fs';

config();

const TIMEZONE = 'America/Sao_Paulo';
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/crm-na-fisioterapia';

// ============================================================================
// MODELOS
// ============================================================================

let Payment, Appointment, Package, Session, Patient;

async function initModels() {
    const paymentSchema = new mongoose.Schema({
        patient: { type: mongoose.Schema.Types.ObjectId },
        doctor: { type: mongoose.Schema.Types.ObjectId },
        appointment: { type: mongoose.Schema.Types.ObjectId, default: null },
        session: { type: mongoose.Schema.Types.ObjectId, default: null },
        package: { type: mongoose.Schema.Types.ObjectId, default: null },
        amount: { type: Number, required: true, min: 0 },
        paymentDate: { type: Date, required: true },
        paymentMethod: { type: String, required: true },
        status: { type: String, default: 'pending' },
        kind: { type: String, default: null },
        billingType: { type: String, default: 'particular' },
        serviceType: { type: String },
    }, { timestamps: true });
    
    const appointmentSchema = new mongoose.Schema({
        patient: { type: mongoose.Schema.Types.ObjectId },
        patientInfo: {
            fullName: String,
            phone: String,
        },
        doctor: { type: mongoose.Schema.Types.ObjectId },
        date: { type: Date, required: true },
        time: { type: String },
        operationalStatus: { type: String, default: 'scheduled' },
        clinicalStatus: { type: String, default: 'pending' },
        paymentStatus: { type: String, default: 'pending' },
        serviceType: { type: String },
        sessionValue: { type: Number, default: 0 },
        billingType: { type: String, default: 'particular' },
        insuranceProvider: { type: String },
        payment: { type: mongoose.Schema.Types.ObjectId },
        session: { type: mongoose.Schema.Types.ObjectId },
        package: { type: mongoose.Schema.Types.ObjectId },
        paymentOrigin: { type: String },
        specialty: { type: String, required: true },
    }, { timestamps: true });

    const packageSchema = new mongoose.Schema({
        patient: { type: mongoose.Schema.Types.ObjectId, required: true },
        doctor: { type: mongoose.Schema.Types.ObjectId, required: true },
        sessionType: { type: String, required: true },
        sessionValue: { type: Number, default: 200 },
        totalSessions: { type: Number, default: 1 },
        sessionsDone: { type: Number, default: 0 },
        status: { type: String, default: 'active' },
        type: { type: String, default: 'therapy' },
        appointments: [{ type: mongoose.Schema.Types.ObjectId }],
    }, { timestamps: true });

    const sessionSchema = new mongoose.Schema({
        patient: { type: mongoose.Schema.Types.ObjectId },
        doctor: { type: mongoose.Schema.Types.ObjectId },
        appointmentId: { type: mongoose.Schema.Types.ObjectId },
        package: { type: mongoose.Schema.Types.ObjectId },
        sessionValue: { type: Number },
        status: { type: String },
        isPaid: { type: Boolean },
        paymentStatus: { type: String },
    }, { timestamps: true });

    Payment = mongoose.model('Payment', paymentSchema);
    Appointment = mongoose.model('Appointment', appointmentSchema);
    Package = mongoose.model('Package', packageSchema);
    Session = mongoose.model('Session', sessionSchema);
    
    try { Patient = mongoose.model('Patient'); } catch { Patient = null; }
}

// ============================================================================
// ANALISADOR INTELIGENTE
// ============================================================================

class SmartAnalyzer {
    constructor() {
        this.report = {
            paidNoPayment: {
                total: 0,
                particular: [],
                package: [],
                convenio: [],
                desconhecido: []
            },
            duplicatePayments: [],
            zeroPayments: [],
            duplicateAppointments: [],
            overusedPackages: [],
            packageWithoutKind: []
        };
    }

    async analyze() {
        console.log('\n🔍 ANALISANDO SISTEMA...\n');
        
        await this.analyzePaidNoPayment();
        await this.analyzeDuplicatePayments();
        await this.analyzeZeroPayments();
        await this.analyzeDuplicateAppointments();
        await this.analyzeOverusedPackages();
        await this.analyzePackageKind();
        
        return this.report;
    }

    // ============================================================================
    // 1. ANALISAR "PAID SEM PAYMENT" - CLASSIFICAÇÃO INTELIGENTE
    // ============================================================================
    async analyzePaidNoPayment() {
        console.log('📊 Analisando appointments pagos sem payment...');
        
        const appointments = await Appointment.find({
            $or: [
                { paymentStatus: 'paid' },
                { operationalStatus: 'paid' }
            ],
            payment: null
        }).lean();

        this.report.paidNoPayment.total = appointments.length;

        for (const appt of appointments) {
            const classification = this.classifyAppointment(appt);
            this.report.paidNoPayment[classification].push({
                id: appt._id.toString(),
                date: moment(appt.date).format('YYYY-MM-DD'),
                time: appt.time,
                billingType: appt.billingType,
                serviceType: appt.serviceType,
                sessionValue: appt.sessionValue,
                operationalStatus: appt.operationalStatus,
                hasPackage: !!appt.package,
                insuranceProvider: appt.insuranceProvider,
                paymentOrigin: appt.paymentOrigin
            });
        }

        console.log(`  Total: ${appointments.length}`);
        console.log(`  ├─ Particular (provável erro): ${this.report.paidNoPayment.particular.length}`);
        console.log(`  ├─ Pacote (normal): ${this.report.paidNoPayment.package.length}`);
        console.log(`  ├─ Convênio (normal): ${this.report.paidNoPayment.convenio.length}`);
        console.log(`  └─ Desconhecido: ${this.report.paidNoPayment.desconhecido.length}`);
    }

    classifyAppointment(appt) {
        // Se tem package, é consumo de pacote (normal não ter payment)
        if (appt.package) return 'package';
        
        // Se é convênio, não deve ter payment de caixa
        if (appt.billingType === 'convenio' || appt.billingType === 'insurance') return 'convenio';
        if (appt.serviceType === 'convenio_session') return 'convenio';
        if (appt.insuranceProvider) return 'convenio';
        
        // Se tem paymentOrigin de pacote
        if (appt.paymentOrigin === 'package_prepaid') return 'package';
        
        // Se é particular e tem valor, é erro
        if (appt.billingType === 'particular' && appt.sessionValue > 0) return 'particular';
        
        return 'desconhecido';
    }

    // ============================================================================
    // 2. ANALISAR PAGAMENTOS DUPLICADOS
    // ============================================================================
    async analyzeDuplicatePayments() {
        console.log('\n📊 Analisando pagamentos duplicados...');
        
        const payments = await Payment.find({
            status: { $in: ['paid', 'pending', 'partial'] }
        }).lean();

        const byAppointment = {};
        for (const p of payments) {
            if (p.appointment) {
                const key = p.appointment.toString();
                if (!byAppointment[key]) byAppointment[key] = [];
                byAppointment[key].push(p);
            }
        }

        for (const [apptId, pays] of Object.entries(byAppointment)) {
            const active = pays.filter(p => ['paid', 'pending', 'partial'].includes(p.status));
            if (active.length > 1) {
                this.report.duplicatePayments.push({
                    appointmentId: apptId,
                    count: active.length,
                    payments: active.map(p => ({
                        id: p._id.toString(),
                        amount: p.amount,
                        status: p.status,
                        createdAt: p.createdAt,
                        method: p.paymentMethod
                    })).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
                });
            }
        }

        console.log(`  Encontrados: ${this.report.duplicatePayments.length} casos`);
    }

    // ============================================================================
    // 3. ANALISAR PAGAMENTOS ZERO
    // ============================================================================
    async analyzeZeroPayments() {
        console.log('\n📊 Analisando pagamentos com valor zero...');
        
        const payments = await Payment.find({
            amount: { $lte: 0 },
            status: { $ne: 'canceled' }
        }).lean();

        this.report.zeroPayments = payments.map(p => ({
            id: p._id.toString(),
            amount: p.amount,
            status: p.status,
            appointment: p.appointment?.toString(),
            package: p.package?.toString()
        }));

        console.log(`  Encontrados: ${this.report.zeroPayments.length}`);
    }

    // ============================================================================
    // 4. ANALISAR APPOINTMENTS DUPLICADOS
    // ============================================================================
    async analyzeDuplicateAppointments() {
        console.log('\n📊 Analisando appointments duplicados...');
        
        const appointments = await Appointment.find({
            operationalStatus: { $ne: 'canceled' }
        }).lean();

        const byKey = {};
        for (const a of appointments) {
            const patientId = a.patient?.toString() || a.patientInfo?.phone;
            if (!patientId) continue;
            
            const date = moment(a.date).format('YYYY-MM-DD');
            const key = `${patientId}_${date}_${a.time}`;
            
            if (!byKey[key]) byKey[key] = [];
            byKey[key].push(a);
        }

        for (const [key, group] of Object.entries(byKey)) {
            if (group.length > 1) {
                this.report.duplicateAppointments.push({
                    key,
                    count: group.length,
                    ids: group.map(a => a._id.toString()),
                    patient: group[0].patientInfo?.fullName || group[0].patient?.toString(),
                    date: moment(group[0].date).format('YYYY-MM-DD'),
                    time: group[0].time
                });
            }
        }

        console.log(`  Encontrados: ${this.report.duplicateAppointments.length} casos`);
    }

    // ============================================================================
    // 5. ANALISAR PACOTES OVERUSED
    // ============================================================================
    async analyzeOverusedPackages() {
        console.log('\n📊 Analisando pacotes overused...');
        
        const packages = await Package.find({
            $expr: { $gt: ['$sessionsDone', '$totalSessions'] }
        }).lean();

        this.report.overusedPackages = packages.map(p => ({
            id: p._id.toString(),
            patientId: p.patient?.toString(),
            sessionsDone: p.sessionsDone,
            totalSessions: p.totalSessions,
            type: p.type,
            status: p.status
        }));

        console.log(`  Encontrados: ${this.report.overusedPackages.length}`);
    }

    // ============================================================================
    // 6. ANALISAR PACKAGE KIND
    // ============================================================================
    async analyzePackageKind() {
        console.log('\n📊 Analisando pagamentos de pacote sem kind...');
        
        const payments = await Payment.find({
            package: { $exists: true, $ne: null },
            $or: [{ kind: null }, { kind: { $ne: 'package_receipt' } }]
        }).lean();

        this.report.packageWithoutKind = payments.map(p => ({
            id: p._id.toString(),
            package: p.package?.toString(),
            kind: p.kind,
            amount: p.amount
        }));

        console.log(`  Encontrados: ${this.report.packageWithoutKind.length}`);
    }
}

// ============================================================================
// CORRETOR SEGURO
// ============================================================================

class SafeFixer {
    constructor(dryRun = true) {
        this.dryRun = dryRun;
        this.log = [];
    }

    async fix(report) {
        console.log('\n' + '='.repeat(80));
        console.log(`EXECUTANDO CORREÇÕES ${this.dryRun ? '(DRY RUN)' : '(REAL)'}`);
        console.log('='.repeat(80) + '\n');

        // ORDEM SEGURA DE CORREÇÃO
        await this.fixZeroPayments(report.zeroPayments);
        await this.fixDuplicatePayments(report.duplicatePayments);
        await this.fixPackageKind(report.packageWithoutKind);
        await this.fixOverusedPackages(report.overusedPackages);
        await this.fixDuplicateAppointments(report.duplicateAppointments);
        // NÃO corrigimos paidNoPayment automaticamente - precisa análise manual
        await this.reportPaidNoPayment(report.paidNoPayment);

        return this.log;
    }

    // ============================================================================
    // 1. CORRIGIR PAGAMENTOS ZERO (DELETAR)
    // ============================================================================
    async fixZeroPayments(zeroPayments) {
        console.log('\n🛠️  Corrigindo pagamentos zero...');
        
        for (const p of zeroPayments) {
            const action = {
                type: 'DELETE_ZERO_PAYMENT',
                id: p.id,
                reason: 'Valor zero ou negativo'
            };

            if (this.dryRun) {
                console.log(`  [DRY RUN] Deletar payment ${p.id} (valor: ${p.amount})`);
            } else {
                await Payment.findByIdAndDelete(p.id);
                console.log(`  ✅ Deletado payment ${p.id}`);
            }
            
            this.log.push(action);
        }
    }

    // ============================================================================
    // 2. CORRIGIR PAGAMENTOS DUPLICADOS (MANTER MAIS RECENTE)
    // ============================================================================
    async fixDuplicatePayments(duplicates) {
        console.log('\n🛠️  Corrigindo pagamentos duplicados...');
        
        for (const dup of duplicates) {
            const sorted = dup.payments; // Já ordenado por createdAt desc
            const keep = sorted[0];
            const cancel = sorted.slice(1);

            console.log(`\n  Appointment ${dup.appointmentId}:`);
            console.log(`    Manter: ${keep.id} (R$ ${keep.amount}, ${keep.method})`);

            for (const p of cancel) {
                const action = {
                    type: 'CANCEL_DUPLICATE_PAYMENT',
                    id: p.id,
                    keep: keep.id,
                    reason: 'Pagamento duplicado'
                };

                if (this.dryRun) {
                    console.log(`    [DRY RUN] Cancelar: ${p.id}`);
                } else {
                    await Payment.findByIdAndUpdate(p.id, {
                        status: 'canceled',
                        canceledAt: new Date(),
                        canceledReason: `Duplicado - mantido ${keep.id}`
                    });
                    console.log(`    ✅ Cancelado: ${p.id}`);
                }

                this.log.push(action);
            }
        }
    }

    // ============================================================================
    // 3. CORRIGIR PACKAGE KIND
    // ============================================================================
    async fixPackageKind(packagePayments) {
        console.log('\n🛠️  Corrigindo kind dos pagamentos de pacote...');
        
        for (const p of packagePayments) {
            const action = {
                type: 'UPDATE_PACKAGE_KIND',
                id: p.id,
                oldKind: p.kind,
                newKind: 'package_receipt'
            };

            if (this.dryRun) {
                console.log(`  [DRY RUN] Atualizar ${p.id} -> kind='package_receipt'`);
            } else {
                await Payment.findByIdAndUpdate(p.id, { kind: 'package_receipt' });
                console.log(`  ✅ Atualizado ${p.id}`);
            }

            this.log.push(action);
        }
    }

    // ============================================================================
    // 4. CORRIGIR PACOTES OVERUSED
    // ============================================================================
    async fixOverusedPackages(overused) {
        console.log('\n🛠️  Corrigindo pacotes overused...');
        
        for (const pkg of overused) {
            const action = {
                type: 'FIX_OVERUSED_PACKAGE',
                id: pkg.id,
                oldSessionsDone: pkg.sessionsDone,
                newSessionsDone: pkg.totalSessions
            };

            console.log(`\n  Pacote ${pkg.id}:`);
            console.log(`    Sessões: ${pkg.sessionsDone}/${pkg.totalSessions}`);

            if (this.dryRun) {
                console.log(`    [DRY RUN] Ajustar para ${pkg.totalSessions}`);
            } else {
                await Package.findByIdAndUpdate(pkg.id, {
                    sessionsDone: pkg.totalSessions,
                    status: 'completed'
                });
                console.log(`    ✅ Ajustado para ${pkg.totalSessions}`);
            }

            this.log.push(action);
        }
    }

    // ============================================================================
    // 5. CORRIGIR APPOINTMENTS DUPLICADOS
    // ============================================================================
    async fixDuplicateAppointments(duplicates) {
        console.log('\n🛠️  Corrigindo appointments duplicados...');
        
        for (const dup of duplicates) {
            const ids = dup.ids;
            const keep = ids[0];
            const cancel = ids.slice(1);

            console.log(`\n  Duplicata ${dup.key}:`);
            console.log(`    Manter: ${keep}`);

            for (const id of cancel) {
                const action = {
                    type: 'CANCEL_DUPLICATE_APPOINTMENT',
                    id: id,
                    keep: keep,
                    reason: 'Appointment duplicado'
                };

                if (this.dryRun) {
                    console.log(`    [DRY RUN] Cancelar: ${id}`);
                } else {
                    await Appointment.findByIdAndUpdate(id, {
                        operationalStatus: 'canceled',
                        paymentStatus: 'canceled',
                        canceledAt: new Date()
                    });
                    console.log(`    ✅ Cancelado: ${id}`);
                }

                this.log.push(action);
            }
        }
    }

    // ============================================================================
    // 6. REPORTAR PAID NO PAYMENT (NÃO CORRIGE AUTOMATICAMENTE)
    // ============================================================================
    async reportPaidNoPayment(paidNoPayment) {
        console.log('\n📋 REPORT: PAID SEM PAYMENT (Análise Manual Necessária)\n');
        
        console.log(`🔴 PARTICULAR (prováveis erros): ${paidNoPayment.particular.length}`);
        if (paidNoPayment.particular.length > 0) {
            console.log('   Estes provavelmente precisam de criação de payment:');
            for (const p of paidNoPayment.particular.slice(0, 5)) {
                console.log(`   - ${p.id}: ${p.date} ${p.time} - R$ ${p.sessionValue}`);
            }
            if (paidNoPayment.particular.length > 5) {
                console.log(`   ... e mais ${paidNoPayment.particular.length - 5} casos`);
            }
            
            // Salvar em arquivo para análise
            const filename = `particular-paid-no-payment-${moment().format('YYYYMMDD')}.json`;
            fs.writeFileSync(filename, JSON.stringify(paidNoPayment.particular, null, 2));
            console.log(`\n   📄 Detalhes salvos em: ${filename}`);
        }

        console.log(`\n🟢 PACOTE (normal): ${paidNoPayment.package.length}`);
        console.log('   Estes estão corretos - consumo de pacote não gera payment');

        console.log(`\n🟢 CONVÊNIO (normal): ${paidNoPayment.convenio.length}`);
        console.log('   Estes estão corretos - convênio não gera payment de caixa');

        console.log(`\n🟡 DESCONHECIDO: ${paidNoPayment.desconhecido.length}`);
        if (paidNoPayment.desconhecido.length > 0) {
            const filename = `unknown-paid-no-payment-${moment().format('YYYYMMDD')}.json`;
            fs.writeFileSync(filename, JSON.stringify(paidNoPayment.desconhecido, null, 2));
            console.log(`   📄 Detalhes salvos em: ${filename}`);
        }

        console.log('\n⚠️  IMPORTANTE:');
        console.log('   Os casos PARTICULAR precisam ser analisados manualmente.');
        console.log('   NÃO criamos payment automaticamente para evitar dinheiro falso.');
    }
}

// ============================================================================
// FUNÇÃO PRINCIPAL
// ============================================================================

async function main() {
    const args = process.argv.slice(2);
    const dryRun = !args.includes('--apply');
    const analyze = args.includes('--analyze');
    
    console.log('='.repeat(80));
    console.log('FINANCIAL SYSTEM FIX - VERSÃO SEGURA');
    console.log('='.repeat(80));
    console.log(`Data: ${moment().tz(TIMEZONE).format('YYYY-MM-DD HH:mm:ss')}`);
    console.log(`Modo: ${dryRun ? 'DRY RUN / ANALYSIS' : '🔴 EXECUÇÃO REAL'}`);
    console.log('='.repeat(80) + '\n');

    if (!dryRun) {
        console.log('⚠️  ⚠️  ⚠️  ATENÇÃO  ⚠️  ⚠️  ⚠️');
        console.log('Você está prestes a MODIFICAR o banco de dados!');
        console.log('Certifique-se de ter um backup!\n');
        console.log('Aguardando 5 segundos... (Ctrl+C para cancelar)');
        await new Promise(r => setTimeout(r, 5000));
    }
    
    try {
        console.log('Conectando ao MongoDB...');
        await mongoose.connect(MONGODB_URI);
        console.log('✅ Conectado\n');
        
        await initModels();
        
        // FASE 1: ANÁLISE
        const analyzer = new SmartAnalyzer();
        const report = await analyzer.analyze();
        
        // Salvar relatório completo
        const reportFile = `financial-analysis-${moment().format('YYYYMMDD-HHmmss')}.json`;
        fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
        console.log(`\n📄 Análise completa salva em: ${reportFile}`);
        
        if (analyze) {
            console.log('\n✅ Análise completa. Verifique o arquivo JSON gerado.');
            return;
        }
        
        // FASE 2: CORREÇÃO (se não for só análise)
        const fixer = new SafeFixer(dryRun);
        const log = await fixer.fix(report);
        
        // Salvar log de correções
        const logFile = `financial-fix-log-${moment().format('YYYYMMDD-HHmmss')}.json`;
        fs.writeFileSync(logFile, JSON.stringify(log, null, 2));
        console.log(`\n📄 Log de correções salvo em: ${logFile}`);
        
    } catch (err) {
        console.error('\n❌ ERRO:', err.message);
        console.error(err.stack);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        console.log('\n🔌 Desconectado do MongoDB');
    }
}

main();
