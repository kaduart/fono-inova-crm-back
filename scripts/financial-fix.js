#!/usr/bin/env node
/**
 * ============================================================================
 * FINANCIAL SYSTEM FIX - CRM FONO INOVA
 * ============================================================================
 * 
 * Script para corrigir problemas identificados na auditoria financeira.
 * 
 * Uso: node financial-fix.js [--dry-run]
 * ============================================================================
 */

import mongoose from 'mongoose';
import moment from 'moment-timezone';
import { config } from 'dotenv';

config();

const TIMEZONE = 'America/Sao_Paulo';
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/crm-na-fisioterapia';

// ============================================================================
// MODELOS
// ============================================================================

let Payment, Appointment, Package;

async function initModels() {
    const paymentSchema = new mongoose.Schema({
        patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient' },
        doctor: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor' },
        appointment: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', default: null },
        session: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', default: null },
        package: { type: mongoose.Schema.Types.ObjectId, ref: 'Package', default: null },
        amount: { type: Number, required: true, min: 0 },
        paymentDate: { type: Date, required: true },
        paymentMethod: { type: String, required: true },
        status: { type: String, default: 'pending' },
        kind: { type: String, default: null },
        billingType: { type: String, default: 'particular' },
    }, { timestamps: true });
    
    const appointmentSchema = new mongoose.Schema({
        patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient' },
        doctor: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor' },
        date: { type: Date, required: true },
        time: { type: String },
        operationalStatus: { type: String, default: 'scheduled' },
        clinicalStatus: { type: String, default: 'pending' },
        paymentStatus: { type: String, default: 'pending' },
        serviceType: { type: String },
        sessionValue: { type: Number, default: 0 },
        billingType: { type: String, default: 'particular' },
        payment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' },
        session: { type: mongoose.Schema.Types.ObjectId, ref: 'Session' },
        package: { type: mongoose.Schema.Types.ObjectId, ref: 'Package' },
        specialty: { type: String, required: true },
    }, { timestamps: true });

    const packageSchema = new mongoose.Schema({
        patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
        doctor: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },
        sessionType: { type: String, required: true },
        sessionValue: { type: Number, default: 200 },
        totalSessions: { type: Number, default: 1 },
        sessionsDone: { type: Number, default: 0 },
        status: { type: String, default: 'active' },
        type: { type: String, default: 'therapy' },
        appointments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' }],
    }, { timestamps: true });

    Payment = mongoose.model('Payment', paymentSchema);
    Appointment = mongoose.model('Appointment', appointmentSchema);
    Package = mongoose.model('Package', packageSchema);
}

// ============================================================================
// CORREÇÕES
// ============================================================================

class FinancialFix {
    constructor(dryRun = true) {
        this.dryRun = dryRun;
        this.fixes = [];
        this.stats = {
            paymentsFixed: 0,
            appointmentsFixed: 0,
            packagesFixed: 0,
            errors: 0
        };
    }

    log(message) {
        console.log(`[FIX] ${message}`);
    }

    async apply() {
        console.log('\n' + '='.repeat(80));
        console.log('APLICANDO CORREÇÕES' + (this.dryRun ? ' (DRY RUN - SIMULAÇÃO)' : ''));
        console.log('='.repeat(80) + '\n');

        await this.fixDuplicatePayments();
        await this.fixPackagePaymentKind();
        await this.fixConvenioMethod();
        await this.fixPaidNoPayment();
        await this.fixPackageOverused();

        this.generateReport();
    }

    // 1. Corrigir pagamentos duplicados
    async fixDuplicatePayments() {
        console.log('\n=== 1. CORRIGINDO PAGAMENTOS DUPLICADOS ===\n');
        
        const payments = await Payment.find({ status: { $in: ['paid', 'pending', 'partial'] } }).lean();
        const byAppointment = {};
        
        for (const p of payments) {
            if (p.appointment) {
                const key = p.appointment.toString();
                if (!byAppointment[key]) byAppointment[key] = [];
                byAppointment[key].push(p);
            }
        }
        
        let fixed = 0;
        for (const [apptId, pays] of Object.entries(byAppointment)) {
            const active = pays.filter(p => ['paid', 'pending', 'partial'].includes(p.status));
            if (active.length > 1) {
                // Manter o mais recente, cancelar os outros
                const sorted = active.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
                const keep = sorted[0];
                const cancel = sorted.slice(1);
                
                console.log(`Appointment ${apptId}: ${active.length} pagamentos`);
                console.log(`  Manter: ${keep._id} (R$ ${keep.amount})`);
                
                if (!this.dryRun) {
                    for (const p of cancel) {
                        await Payment.findByIdAndUpdate(p._id, {
                            status: 'canceled',
                            canceledAt: new Date(),
                            canceledReason: 'Duplicado - consolidado em ' + keep._id
                        });
                        console.log(`  Cancelado: ${p._id}`);
                    }
                } else {
                    for (const p of cancel) {
                        console.log(`  [DRY RUN] Cancelar: ${p._id}`);
                    }
                }
                fixed++;
            }
        }
        
        this.stats.paymentsFixed += fixed;
        console.log(`\n${fixed} grupos de duplicatas processados`);
    }

    // 2. Corrigir kind dos pagamentos de pacote
    async fixPackagePaymentKind() {
        console.log('\n=== 2. CORRIGINDO KIND DE PACOTES ===\n');
        
        const payments = await Payment.find({
            package: { $exists: true, $ne: null },
            $or: [{ kind: null }, { kind: { $ne: 'package_receipt' } }]
        });
        
        console.log(`Encontrados ${payments.length} pagamentos de pacote para corrigir`);
        
        if (!this.dryRun && payments.length > 0) {
            const result = await Payment.updateMany(
                { 
                    package: { $exists: true, $ne: null },
                    $or: [{ kind: null }, { kind: { $ne: 'package_receipt' } }]
                },
                { kind: 'package_receipt' }
            );
            console.log(`Corrigidos: ${result.modifiedCount}`);
            this.stats.paymentsFixed += result.modifiedCount;
        } else {
            console.log(`[DRY RUN] Seriam corrigidos: ${payments.length}`);
        }
    }

    // 3. Corrigir método de convênio
    async fixConvenioMethod() {
        console.log('\n=== 3. CORRIGINDO MÉTODO DE CONVÊNIO ===\n');
        
        const payments = await Payment.find({
            $or: [{ billingType: 'convenio' }, { billingType: 'insurance' }],
            paymentMethod: { $ne: 'convenio' }
        });
        
        console.log(`Encontrados ${payments.length} pagamentos de convênio para corrigir`);
        
        if (!this.dryRun && payments.length > 0) {
            const result = await Payment.updateMany(
                {
                    $or: [{ billingType: 'convenio' }, { billingType: 'insurance' }],
                    paymentMethod: { $ne: 'convenio' }
                },
                { paymentMethod: 'convenio' }
            );
            console.log(`Corrigidos: ${result.modifiedCount}`);
            this.stats.paymentsFixed += result.modifiedCount;
        } else {
            console.log(`[DRY RUN] Seriam corrigidos: ${payments.length}`);
        }
    }

    // 4. Corrigir appointments pagos sem payment
    async fixPaidNoPayment() {
        console.log('\n=== 4. CORRIGINDO APPOINTMENTS PAGOS SEM PAYMENT ===\n');
        
        const appointments = await Appointment.find({
            $or: [{ paymentStatus: 'paid' }, { operationalStatus: 'paid' }],
            payment: null
        }).limit(50); // Limitar para análise
        
        console.log(`Encontrados ${appointments.length} appointments pagos sem payment`);
        console.log('Estes precisam de análise manual - podem ser casos de:');
        console.log('  - Pagamentos removidos mas appointment não atualizado');
        console.log('  - Consumo de pacote sem registro adequado');
        console.log('  - Convênio marcado como pago incorretamente');
        
        for (const a of appointments.slice(0, 5)) {
            console.log(`\n  Appointment ${a._id}:`);
            console.log(`    Status: ${a.operationalStatus} / ${a.paymentStatus}`);
            console.log(`    Paciente: ${a.patient?.toString() || 'N/A'}`);
            console.log(`    Data: ${moment(a.date).format('YYYY-MM-DD')} ${a.time}`);
            console.log(`    Valor: ${a.sessionValue}`);
            console.log(`    Billing: ${a.billingType}`);
        }
    }

    // 5. Corrigir pacotes overused
    async fixPackageOverused() {
        console.log('\n=== 5. CORRIGINDO PACOTES OVERUSED ===\n');
        
        const packages = await Package.find({
            $expr: { $gt: ['$sessionsDone', '$totalSessions'] }
        });
        
        console.log(`Encontrados ${packages.length} pacotes overused`);
        
        for (const pkg of packages) {
            console.log(`\n  Pacote ${pkg._id}:`);
            console.log(`    Sessões feitas: ${pkg.sessionsDone}`);
            console.log(`    Total sessões: ${pkg.totalSessions}`);
            
            if (!this.dryRun) {
                // Ajustar para o máximo permitido
                await Package.findByIdAndUpdate(pkg._id, {
                    sessionsDone: pkg.totalSessions,
                    status: 'completed'
                });
                console.log(`    Corrigido: sessionsDone = ${pkg.totalSessions}`);
                this.stats.packagesFixed++;
            } else {
                console.log(`    [DRY RUN] Ajustar para: ${pkg.totalSessions}`);
            }
        }
    }

    generateReport() {
        console.log('\n' + '='.repeat(80));
        console.log('RELATÓRIO DE CORREÇÕES');
        console.log('='.repeat(80));
        console.log(`\nModo: ${this.dryRun ? 'DRY RUN (simulação)' : 'EXECUÇÃO REAL'}`);
        console.log(`\n📊 ESTATÍSTICAS:`);
        console.log(`  Payments corrigidos: ${this.stats.paymentsFixed}`);
        console.log(`  Appointments corrigidos: ${this.stats.appointmentsFixed}`);
        console.log(`  Packages corrigidos: ${this.stats.packagesFixed}`);
        console.log(`  Erros: ${this.stats.errors}`);
        console.log('\n' + '='.repeat(80));
    }
}

// ============================================================================
// FUNÇÃO PRINCIPAL
// ============================================================================

async function main() {
    const args = process.argv.slice(2);
    const dryRun = !args.includes('--apply');
    
    console.log('='.repeat(80));
    console.log('FINANCIAL SYSTEM FIX - CRM FONO INOVA');
    console.log('='.repeat(80));
    console.log(`Data: ${moment().tz(TIMEZONE).format('YYYY-MM-DD HH:mm:ss')}`);
    console.log(`Modo: ${dryRun ? 'DRY RUN (adicione --apply para executar)' : 'EXECUÇÃO REAL'}`);
    console.log('='.repeat(80) + '\n');
    
    if (dryRun) {
        console.log('⚠️  MODO SIMULAÇÃO - Nenhuma alteração será feita no banco de dados');
        console.log('    Execute com --apply para aplicar as correções\n');
    } else {
        console.log('🔴 EXECUÇÃO REAL - As correções serão aplicadas!\n');
    }
    
    try {
        console.log('Conectando ao MongoDB...');
        await mongoose.connect(MONGODB_URI);
        console.log('✅ Conectado\n');
        
        await initModels();
        
        const fix = new FinancialFix(dryRun);
        await fix.apply();
        
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
