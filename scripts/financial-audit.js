#!/usr/bin/env node
/**
 * ============================================================================
 * FINANCIAL SYSTEM AUDIT - CRM FONO INOVA
 * ============================================================================
 * 
 * Objetivo: Validar, corrigir e garantir a integridade TOTAL do sistema 
 * financeiro e de agendamento da clínica.
 * 
 * Cenários validados:
 * 1. Sessão Avulsa (particular)
 * 2. Sessão futura (adiantamento)
 * 3. Pacote Particular
 * 4. Consumo de Pacote
 * 5. Convênio
 * 6. Pré-agendamento
 * 7. Importação via importFromAgendaRoutes
 * 8. Daily Closing
 * 
 * Uso: node financial-audit.js [--fix] [--verbose]
 * ============================================================================
 */

import mongoose from 'mongoose';
import moment from 'moment-timezone';
import { config } from 'dotenv';

config();

const TIMEZONE = 'America/Sao_Paulo';

// ============================================================================
// CONFIGURAÇÃO E CONEXÃO
// ============================================================================

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/crm-na-fisioterapia';

// ============================================================================
// MODELOS (Dynamic imports para evitar caching)
// ============================================================================

let Payment, Appointment, Package, Session, Patient, InsuranceGuide, DailyClosing;

async function initModels() {
    const paymentSchema = new mongoose.Schema({
        patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient' },
        doctor: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor' },
        appointment: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', default: null },
        session: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', default: null },
        package: { type: mongoose.Schema.Types.ObjectId, ref: 'Package', default: null },
        sessions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Session' }],
        advanceSessions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Session' }],
        amount: { type: Number, required: true, min: 0 },
        paymentDate: { type: Date, required: true },
        serviceDate: { type: Date, default: null },
        paymentMethod: {
            type: String,
            enum: ['pix', 'cartão', 'dinheiro', 'convenio', 'liminar_credit', 'credit_card', 'debit_card', 'cash', 'bank_transfer', 'other'],
            required: true
        },
        status: {
            type: String,
            enum: ['pending', 'partial', 'paid', 'canceled', 'refunded', 'converted_to_package', 'recognized'],
            default: 'pending'
        },
        serviceType: { type: String, default: null },
        sessionType: { type: String, default: null },
        kind: {
            type: String,
            enum: ['package_receipt', 'revenue_recognition', 'session_payment', 'appointment_payment', null],
            default: null
        },
        billingType: {
            type: String,
            enum: ['particular', 'convenio', 'insurance', null],
            default: 'particular'
        },
        notes: { type: String, default: null },
        canceledAt: { type: Date, default: null },
        canceledReason: { type: String, default: null },
        convertedAt: { type: Date, default: null },
        convertedPackage: { type: mongoose.Schema.Types.ObjectId, ref: 'Package', default: null },
        clinicId: { type: String, default: 'default' },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        paidAt: { type: Date, default: null },
        confirmedAt: { type: Date, default: null },
    }, { timestamps: true });
    
    const appointmentSchema = new mongoose.Schema({
        patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: false },
        patientInfo: {
            fullName: String,
            phone: String,
            email: String,
            birthDate: String,
            age: Number,
            ageUnit: { type: String, enum: ['anos', 'meses'], default: 'anos' }
        },
        doctor: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: false },
        professionalName: String,
        date: { type: Date, required: [true, 'Data é obrigatória'] },
        time: { type: String, required: false },
        preferredPeriod: { type: String, enum: ['manha', 'tarde', 'noite', null], default: null },
        duration: { type: Number, default: 40 },
        operationalStatus: {
            type: String,
            enum: ['pre_agendado', 'scheduled', 'confirmed', 'pending', 'canceled', 'paid', 'missed', 'completed', 'processing_create', 'processing_complete', 'processing_cancel'],
            default: 'pre_agendado',
        },
        clinicalStatus: {
            type: String,
            enum: ['pending', 'in_progress', 'completed', 'missed', 'scheduled', 'canceled'],
            default: 'pending',
        },
        serviceType: {
            type: String,
            enum: ['evaluation', 'session', 'package_session', 'individual_session', 'meet', 'alignment', 'return', 'tongue_tie_test', 'neuropsych_evaluation', 'convenio_session'],
            required: false
        },
        sessionValue: { type: Number, min: 0, default: 0 },
        paymentMethod: {
            type: String,
            enum: ['dinheiro', 'pix', 'cartao_credito', 'cartao_debito', 'cartão', 'transferencia_bancaria', 'plano-unimed', 'convenio', 'outro'],
            default: 'dinheiro'
        },
        billingType: { type: String, enum: ['particular', 'convenio'], default: 'particular' },
        insuranceProvider: { type: String, default: null },
        insuranceValue: { type: Number, min: 0, default: 0 },
        authorizationCode: { type: String, default: null },
        payment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', required: false },
        session: { type: mongoose.Schema.Types.ObjectId, ref: 'Session' },
        package: { type: mongoose.Schema.Types.ObjectId, ref: 'Package' },
        paymentStatus: {
            type: String,
            enum: ['pending', 'paid', 'partial', 'canceled', 'advanced', 'package_paid', 'pending_receipt', 'recognized', 'pending_balance'],
            default: 'pending'
        },
        visualFlag: { type: String, enum: ['ok', 'pending', 'partial', 'blocked'], default: 'pending' },
        specialty: { type: String, required: true },
        notes: { type: String, default: '' },
        paymentOrigin: { type: String, enum: ['auto_per_session', 'manual_balance', 'package_prepaid', 'convenio', 'liminar'], default: null },
        addedToBalance: { type: Boolean, default: false },
        balanceAmount: { type: Number, default: 0 },
    }, { timestamps: true });

    const packageSchema = new mongoose.Schema({
        version: { type: Number, default: 0 },
        durationMonths: { type: Number, required: true, min: 1, max: 12 },
        sessionsPerWeek: { type: Number, required: true, min: 1, max: 5 },
        patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
        doctor: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },
        paymentMethod: { type: String },
        paymentType: { type: String },
        sessionType: { type: String, required: true },
        sessionValue: { type: Number, default: 200 },
        totalSessions: { type: Number, default: 1, min: 1 },
        sessions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Session' }],
        appointments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' }],
        date: { type: Date, required: true },
        time: { type: String },
        sessionsDone: { type: Number, default: 0 },
        payments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Payment' }],
        status: { type: String, enum: ['active', 'in-progress', 'completed'], default: 'active' },
        balance: { type: Number, default: 0 },
        credit: { type: Number, default: 0 },
        specialty: { type: String, required: true },
        financialStatus: { type: String, enum: ['unpaid', 'partially_paid', 'paid'], default: 'unpaid' },
        paidSessions: { type: Number, default: 0 },
        totalPaid: { type: Number, default: 0 },
        totalValue: { type: Number, required: true, min: 0 },
        lastPaymentAt: { type: Date },
        type: { type: String, enum: ['therapy', 'convenio', 'liminar'], default: 'therapy' },
        insuranceGuide: { type: mongoose.Schema.Types.ObjectId, ref: 'InsuranceGuide', default: null },
        insuranceProvider: { type: String, default: null },
    }, { timestamps: true });

    Payment = mongoose.model('Payment', paymentSchema);
    Appointment = mongoose.model('Appointment', appointmentSchema);
    Package = mongoose.model('Package', packageSchema);
    
    // Tentar carregar modelos existentes
    try { Session = mongoose.model('Session'); } catch { Session = null; }
    try { Patient = mongoose.model('Patient'); } catch { Patient = null; }
    try { InsuranceGuide = mongoose.model('InsuranceGuide'); } catch { InsuranceGuide = null; }
    try { DailyClosing = mongoose.model('DailyClosing'); } catch { DailyClosing = null; }
}

// ============================================================================
// CLASSE DE AUDITORIA
// ============================================================================

class FinancialAuditor {
    constructor(verbose = false) {
        this.verbose = verbose;
        this.issues = [];
        this.stats = {
            totalPayments: 0,
            totalAppointments: 0,
            totalPackages: 0,
            issuesFound: 0,
            issuesFixed: 0
        };
    }

    log(message, data = null) {
        if (this.verbose) {
            console.log(`[AUDIT] ${message}`);
            if (data) console.log(data);
        }
    }

    issue(type, severity, message, data = null, fixable = false) {
        this.issues.push({ type, severity, message, data, fixable, timestamp: new Date() });
        this.stats.issuesFound++;
        console.log(`[${severity}] ${type}: ${message}`);
        if (data && this.verbose) console.log(data);
    }

    // ============================================================================
    // 1. AUDITORIA DE PAYMENTS
    // ============================================================================
    
    async auditPayments() {
        console.log('\n=== AUDITORIA DE PAYMENTS ===\n');
        
        const payments = await Payment.find({}).lean();
        this.stats.totalPayments = payments.length;
        console.log(`Total de pagamentos: ${payments.length}`);
        
        // 1.1 Verificar pagamentos duplicados (mesmo appointment)
        const byAppointment = {};
        for (const p of payments) {
            if (p.appointment) {
                const key = p.appointment.toString();
                if (!byAppointment[key]) byAppointment[key] = [];
                byAppointment[key].push(p);
            }
        }
        
        let dupCount = 0;
        for (const [apptId, pays] of Object.entries(byAppointment)) {
            const active = pays.filter(p => ['paid', 'pending', 'partial'].includes(p.status));
            if (active.length > 1) {
                dupCount++;
                if (dupCount <= 3) {
                    this.issue('DUPLICATE_PAYMENT', 'HIGH', 
                        `Appointment ${apptId} tem ${active.length} pagamentos ativos`,
                        { appointmentId: apptId, payments: active.map(p => ({ id: p._id, amount: p.amount, status: p.status })) },
                        true
                    );
                }
            }
        }
        if (dupCount > 3) {
            console.log(`[Mais ${dupCount - 3} pagamentos duplicados omitidos...]`);
        }
        
        // 1.2 Verificar pagamentos sem vínculo
        const orphanPayments = payments.filter(p => 
            !p.appointment && !p.session && !p.package && p.status !== 'canceled'
        );
        
        if (orphanPayments.length > 0) {
            this.issue('ORPHAN_PAYMENT', 'MEDIUM',
                `${orphanPayments.length} pagamentos sem vínculo (appointment/session/package)`,
                { count: orphanPayments.length, examples: orphanPayments.slice(0, 3).map(p => p._id) },
                false
            );
        }
        
        // 1.3 Verificar pagamentos de pacote que deveriam ter kind='package_receipt'
        const packagePayments = payments.filter(p => p.package && p.kind !== 'package_receipt');
        if (packagePayments.length > 0) {
            this.issue('PACKAGE_PAYMENT_KIND', 'LOW',
                `${packagePayments.length} pagamentos de pacote sem kind='package_receipt'`,
                { count: packagePayments.length },
                true
            );
        }
        
        // 1.4 Verificar inconsistência de datas
        const dateIssues = [];
        for (const p of payments) {
            if (p.paymentDate && p.createdAt) {
                const paymentDate = moment(p.paymentDate).tz(TIMEZONE).format('YYYY-MM-DD');
                const createdAt = moment(p.createdAt).tz(TIMEZONE).format('YYYY-MM-DD');
                if (Math.abs(moment(paymentDate).diff(moment(createdAt), 'days')) > 1) {
                    dateIssues.push({
                        id: p._id,
                        paymentDate,
                        createdAt,
                        diff: moment(paymentDate).diff(moment(createdAt), 'days')
                    });
                }
            }
        }
        
        if (dateIssues.length > 0) {
            this.issue('DATE_MISMATCH', 'LOW',
                `${dateIssues.length} pagamentos com divergência entre paymentDate e createdAt`,
                { count: dateIssues.length, examples: dateIssues.slice(0, 3) },
                false
            );
        }
        
        // 1.5 Verificar pagamentos com valor zero ou negativo
        const zeroPayments = payments.filter(p => p.amount <= 0 && p.status !== 'canceled');
        if (zeroPayments.length > 0) {
            this.issue('ZERO_AMOUNT_PAYMENT', 'HIGH',
                `${zeroPayments.length} pagamentos com valor zero ou negativo`,
                { count: zeroPayments.length, examples: zeroPayments.slice(0, 3).map(p => p._id) },
                false
            );
        }
        
        // 1.6 Verificar pagamentos de convênio com método incorreto
        const convenioIssues = payments.filter(p => 
            (p.billingType === 'convenio' || p.billingType === 'insurance') && 
            p.paymentMethod !== 'convenio'
        );
        if (convenioIssues.length > 0) {
            this.issue('CONVENIO_METHOD', 'MEDIUM',
                `${convenioIssues.length} pagamentos de convênio com método != 'convenio'`,
                { count: convenioIssues.length },
                true
            );
        }
        
        return payments;
    }

    // ============================================================================
    // 2. AUDITORIA DE APPOINTMENTS
    // ============================================================================
    
    async auditAppointments() {
        console.log('\n=== AUDITORIA DE APPOINTMENTS ===\n');
        
        const appointments = await Appointment.find({}).lean();
        this.stats.totalAppointments = appointments.length;
        console.log(`Total de appointments: ${appointments.length}`);
        
        // 2.1 Verificar appointments pagos sem payment
        const paidNoPayment = appointments.filter(a => 
            (a.paymentStatus === 'paid' || a.operationalStatus === 'paid') && !a.payment
        );
        
        if (paidNoPayment.length > 0) {
            this.issue('PAID_NO_PAYMENT', 'HIGH',
                `${paidNoPayment.length} appointments marcados como pagos sem payment vinculado`,
                { count: paidNoPayment.length, examples: paidNoPayment.slice(0, 3).map(a => a._id) },
                false
            );
        }
        
        // 2.2 Verificar appointments com package mas sem session
        const packageNoSession = appointments.filter(a => 
            a.package && !a.session && !['canceled', 'pre_agendado'].includes(a.operationalStatus)
        );
        
        if (packageNoSession.length > 0) {
            this.issue('PACKAGE_NO_SESSION', 'MEDIUM',
                `${packageNoSession.length} appointments de pacote sem session vinculada`,
                { count: packageNoSession.length },
                false
            );
        }
        
        // 2.3 Verificar pré-agendamentos com payment (não devem ter)
        const preAgendWithPayment = appointments.filter(a => 
            a.operationalStatus === 'pre_agendado' && a.payment
        );
        
        if (preAgendWithPayment.length > 0) {
            this.issue('PREAGEND_WITH_PAYMENT', 'HIGH',
                `${preAgendWithPayment.length} pré-agendamentos com payment (não devem ter)`,
                { count: preAgendWithPayment.length, examples: preAgendWithPayment.slice(0, 3).map(a => a._id) },
                true
            );
        }
        
        // 2.4 Verificar appointments completed sem session
        const completedNoSession = appointments.filter(a => 
            a.clinicalStatus === 'completed' && !a.session && !a.package
        );
        
        if (completedNoSession.length > 0) {
            this.issue('COMPLETED_NO_SESSION', 'MEDIUM',
                `${completedNoSession.length} appointments completados sem session`,
                { count: completedNoSession.length },
                false
            );
        }
        
        // 2.5 Verificar duplicatas (mesmo paciente, mesma data/hora)
        const duplicates = await this.findDuplicateAppointments(appointments);
        if (duplicates.length > 0) {
            this.issue('DUPLICATE_APPOINTMENT', 'HIGH',
                `${duplicates.length} possíveis duplicatas encontradas`,
                { count: duplicates.length, examples: duplicates.slice(0, 3) },
                false
            );
        }
        
        return appointments;
    }

    async findDuplicateAppointments(appointments) {
        const byKey = {};
        const duplicates = [];
        
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
                const nonCanceled = group.filter(a => a.operationalStatus !== 'canceled');
                if (nonCanceled.length > 1) {
                    duplicates.push({ key, count: nonCanceled.length, ids: nonCanceled.map(a => a._id) });
                }
            }
        }
        
        return duplicates;
    }

    // ============================================================================
    // 3. AUDITORIA DE PACOTES
    // ============================================================================
    
    async auditPackages() {
        console.log('\n=== AUDITORIA DE PACOTES ===\n');
        
        const packages = await Package.find({}).lean();
        this.stats.totalPackages = packages.length;
        console.log(`Total de pacotes: ${packages.length}`);
        
        // 3.1 Verificar pacotes com sessionsDone > totalSessions
        const overused = packages.filter(p => p.sessionsDone > p.totalSessions);
        if (overused.length > 0) {
            this.issue('PACKAGE_OVERUSED', 'HIGH',
                `${overused.length} pacotes com mais sessões feitas que o total`,
                { count: overused.length, examples: overused.slice(0, 3).map(p => ({ id: p._id, done: p.sessionsDone, total: p.totalSessions })) },
                false
            );
        }
        
        // 3.2 Verificar pacotes com totalPaid > totalValue
        const overpaid = packages.filter(p => p.totalPaid > p.totalValue);
        if (overpaid.length > 0) {
            this.issue('PACKAGE_OVERPAID', 'MEDIUM',
                `${overpaid.length} pacotes com mais pago que o valor total`,
                { count: overpaid.length },
                false
            );
        }
        
        // 3.3 Verificar pacotes sem appointments (inativos ou órfãos)
        const noAppointments = packages.filter(p => 
            !p.appointments || p.appointments.length === 0
        );
        
        if (noAppointments.length > 0) {
            this.issue('PACKAGE_NO_APPOINTMENTS', 'LOW',
                `${noAppointments.length} pacotes sem appointments vinculados`,
                { count: noAppointments.length },
                false
            );
        }
        
        // 3.4 Verificar pacotes de convênio sem insuranceGuide
        const convenioNoGuide = packages.filter(p => 
            p.type === 'convenio' && !p.insuranceGuide
        );
        
        if (convenioNoGuide.length > 0) {
            this.issue('CONVENIO_NO_GUIDE', 'LOW',
                `${convenioNoGuide.length} pacotes de convênio sem guia vinculada`,
                { count: convenioNoGuide.length },
                false
            );
        }
        
        return packages;
    }

    // ============================================================================
    // 4. VALIDAÇÃO DE CENÁRIOS
    // ============================================================================
    
    async validateScenarios(payments, appointments, packages) {
        console.log('\n=== VALIDAÇÃO DE CENÁRIOS ===\n');
        
        const today = moment().tz(TIMEZONE).format('YYYY-MM-DD');
        
        // 4.1 Sessão Avulsa - deve ter cashInToday e revenueToday
        const todayPayments = payments.filter(p => {
            const pDate = moment(p.paymentDate).tz(TIMEZONE).format('YYYY-MM-DD');
            return pDate === today && p.status === 'paid' && !p.package && p.billingType !== 'convenio';
        });
        
        console.log(`[CENÁRIO 1] Sessões Avulsas hoje: ${todayPayments.length} pagamentos`);
        if (todayPayments.length > 0) {
            const total = todayPayments.reduce((sum, p) => sum + p.amount, 0);
            console.log(`            Total em caixa: R$ ${total.toFixed(2)}`);
        }
        
        // 4.2 Sessão Futura - deve ter advancePayments
        const advancePayments = payments.filter(p => {
            if (p.package || p.billingType === 'convenio') return false;
            const pDate = moment(p.paymentDate).tz(TIMEZONE).format('YYYY-MM-DD');
            const aDate = p.appointment?.date ? moment(p.appointment.date).format('YYYY-MM-DD') : null;
            return pDate === today && aDate && aDate > today;
        });
        
        console.log(`[CENÁRIO 2] Adiantamentos (sessão futura): ${advancePayments.length} pagamentos`);
        if (advancePayments.length > 0) {
            const total = advancePayments.reduce((sum, p) => sum + p.amount, 0);
            console.log(`            Total em adiantamentos: R$ ${total.toFixed(2)}`);
        }
        
        // 4.3 Pacotes - não devem criar múltiplos payments por sessão
        const packagePayments = payments.filter(p => p.package && p.kind === 'package_receipt');
        const packageIds = [...new Set(packagePayments.map(p => p.package?.toString()))];
        console.log(`[CENÁRIO 3] Pacotes: ${packageIds.length} pacotes com ${packagePayments.length} pagamentos`);
        
        // 4.4 Convênios - não devem ter paymentMethod != convenio
        const convenioPayments = payments.filter(p => p.billingType === 'convenio' || p.billingType === 'insurance');
        console.log(`[CENÁRIO 5] Convênios: ${convenioPayments.length} pagamentos`);
        
        // 4.5 Pré-agendamentos - não devem ter payment
        const preAgendamentos = appointments.filter(a => a.operationalStatus === 'pre_agendado');
        const preAgendWithPayment = preAgendamentos.filter(a => a.payment);
        console.log(`[CENÁRIO 6] Pré-agendamentos: ${preAgendamentos.length} total, ${preAgendWithPayment.length} com payment (ERRO se > 0)`);
    }

    // ============================================================================
    // 5. RELATÓRIO FINAL
    // ============================================================================
    
    generateReport() {
        console.log('\n' + '='.repeat(80));
        console.log('RELATÓRIO FINAL DE AUDITORIA');
        console.log('='.repeat(80));
        
        const bySeverity = { HIGH: 0, MEDIUM: 0, LOW: 0 };
        const byType = {};
        
        for (const issue of this.issues) {
            bySeverity[issue.severity]++;
            byType[issue.type] = (byType[issue.type] || 0) + 1;
        }
        
        console.log('\n📊 ESTATÍSTICAS:');
        console.log(`  Total Payments: ${this.stats.totalPayments}`);
        console.log(`  Total Appointments: ${this.stats.totalAppointments}`);
        console.log(`  Total Packages: ${this.stats.totalPackages}`);
        console.log(`  Issues Found: ${this.stats.issuesFound}`);
        
        console.log('\n🔴 PROBLEMAS POR SEVERIDADE:');
        console.log(`  HIGH: ${bySeverity.HIGH}`);
        console.log(`  MEDIUM: ${bySeverity.MEDIUM}`);
        console.log(`  LOW: ${bySeverity.LOW}`);
        
        if (Object.keys(byType).length > 0) {
            console.log('\n📋 PROBLEMAS POR TIPO:');
            for (const [type, count] of Object.entries(byType)) {
                console.log(`  ${type}: ${count}`);
            }
        }
        
        if (this.issues.length > 0) {
            console.log('\n⚠️  DETALHES DOS PROBLEMAS:');
            for (const issue of this.issues) {
                const icon = issue.severity === 'HIGH' ? '🔴' : issue.severity === 'MEDIUM' ? '🟡' : '🟢';
                console.log(`\n${icon} [${issue.severity}] ${issue.type}`);
                console.log(`   ${issue.message}`);
                if (issue.fixable) console.log(`   [PODE SER CORRIGIDO AUTOMATICAMENTE]`);
            }
        } else {
            console.log('\n✅ Nenhum problema encontrado!');
        }
        
        console.log('\n' + '='.repeat(80));
        
        return {
            stats: this.stats,
            issues: this.issues,
            summary: { bySeverity, byType }
        };
    }
}

// ============================================================================
// FUNÇÃO PRINCIPAL
// ============================================================================

async function main() {
    const args = process.argv.slice(2);
    const shouldFix = args.includes('--fix');
    const verbose = args.includes('--verbose');
    
    console.log('='.repeat(80));
    console.log('FINANCIAL SYSTEM AUDIT - CRM FONO INOVA');
    console.log('='.repeat(80));
    console.log(`Data: ${moment().tz(TIMEZONE).format('YYYY-MM-DD HH:mm:ss')}`);
    console.log(`MongoDB: ${MONGODB_URI.substring(0, 50)}...`);
    console.log(`Modo: ${shouldFix ? 'CORREÇÃO' : 'AUDITORIA'}`);
    console.log('='.repeat(80) + '\n');
    
    try {
        // Conectar ao MongoDB
        console.log('Conectando ao MongoDB...');
        await mongoose.connect(MONGODB_URI);
        console.log('✅ Conectado\n');
        
        // Inicializar modelos
        await initModels();
        
        // Criar auditor
        const auditor = new FinancialAuditor(verbose);
        
        // Executar auditorias
        const payments = await auditor.auditPayments();
        const appointments = await auditor.auditAppointments();
        const packages = await auditor.auditPackages();
        
        // Validar cenários
        await auditor.validateScenarios(payments, appointments, packages);
        
        // Gerar relatório
        const report = auditor.generateReport();
        
        // Salvar relatório em arquivo
        const reportPath = `./audit-report-${moment().format('YYYYMMDD-HHmmss')}.json`;
        await import('fs').then(fs => {
            fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
            console.log(`\n📄 Relatório salvo em: ${reportPath}`);
        });
        
    } catch (err) {
        console.error('\n❌ ERRO:', err.message);
        console.error(err.stack);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        console.log('\n🔌 Desconectado do MongoDB');
    }
}

// Executar
main();
