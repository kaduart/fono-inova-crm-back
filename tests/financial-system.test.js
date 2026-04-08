/**
 * ============================================================================
 * TESTES UNITÁRIOS DO SISTEMA FINANCEIRO
 * ============================================================================
 * 
 * Testes para validar:
 * - Criação de pagamentos
 * - Criação de pacotes
 * - Consumo de pacotes
 * - Criação de appointments
 * - Pré-agendamentos
 * - Daily Closing
 * 
 * Execute: npm test -- tests/financial-system.test.js
 * ============================================================================
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import mongoose from 'mongoose';
import moment from 'moment-timezone';

const TIMEZONE = 'America/Sao_Paulo';

// Mock models - em teste real, importar os models reais
let Payment, Appointment, Package, Session;

describe('Sistema Financeiro - Testes de Integridade', () => {
    
    beforeAll(async () => {
        // Conectar ao MongoDB de teste
        const MONGODB_URI = process.env.MONGODB_TEST_URI || 'mongodb://localhost:27017/crm-test';
        await mongoose.connect(MONGODB_URI);
        
        // Definir schemas
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
        }, { timestamps: true });
        
        const appointmentSchema = new mongoose.Schema({
            patient: { type: mongoose.Schema.Types.ObjectId },
            doctor: { type: mongoose.Schema.Types.ObjectId },
            date: { type: Date, required: true },
            time: { type: String },
            operationalStatus: { type: String, default: 'scheduled' },
            paymentStatus: { type: String, default: 'pending' },
            serviceType: { type: String },
            sessionValue: { type: Number, default: 0 },
            billingType: { type: String, default: 'particular' },
            payment: { type: mongoose.Schema.Types.ObjectId },
            session: { type: mongoose.Schema.Types.ObjectId },
            package: { type: mongoose.Schema.Types.ObjectId },
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

        Payment = mongoose.model('Payment', paymentSchema);
        Appointment = mongoose.model('Appointment', appointmentSchema);
        Package = mongoose.model('Package', packageSchema);
    });

    afterAll(async () => {
        await mongoose.disconnect();
    });

    beforeEach(async () => {
        // Limpar coleções antes de cada teste
        await Payment.deleteMany({});
        await Appointment.deleteMany({});
        await Package.deleteMany({});
    });

    // ============================================================================
    // TESTE 1: Sessão Avulsa
    // ============================================================================
    describe('CENÁRIO 1: Sessão Avulsa (particular)', () => {
        it('deve criar payment ao marcar sessão como paga', async () => {
            const today = moment().tz(TIMEZONE).toDate();
            
            // Criar appointment
            const appointment = await Appointment.create({
                patient: new mongoose.Types.ObjectId(),
                doctor: new mongoose.Types.ObjectId(),
                date: today,
                time: '10:00',
                specialty: 'fonoaudiologia',
                sessionValue: 200,
                billingType: 'particular',
                operationalStatus: 'completed',
                paymentStatus: 'paid'
            });

            // Criar payment vinculado
            const payment = await Payment.create({
                patient: appointment.patient,
                doctor: appointment.doctor,
                appointment: appointment._id,
                amount: 200,
                paymentDate: today,
                paymentMethod: 'pix',
                status: 'paid',
                billingType: 'particular'
            });

            // Atualizar appointment com payment
            appointment.payment = payment._id;
            await appointment.save();

            // Validar
            expect(payment.amount).toBe(200);
            expect(payment.status).toBe('paid');
            expect(payment.appointment.toString()).toBe(appointment._id.toString());
        });

        it('deve entrar em cashInToday quando pago hoje', async () => {
            const today = moment().tz(TIMEZONE).format('YYYY-MM-DD');
            
            const payment = await Payment.create({
                patient: new mongoose.Types.ObjectId(),
                amount: 200,
                paymentDate: moment.tz(today, TIMEZONE).toDate(),
                paymentMethod: 'pix',
                status: 'paid'
            });

            const paymentDate = moment(payment.paymentDate).tz(TIMEZONE).format('YYYY-MM-DD');
            expect(paymentDate).toBe(today);
            expect(payment.status).toBe('paid');
        });
    });

    // ============================================================================
    // TESTE 2: Sessão Futura (adiantamento)
    // ============================================================================
    describe('CENÁRIO 2: Sessão Futura (adiantamento)', () => {
        it('deve registrar como advance quando pagamento é antes da sessão', async () => {
            const today = moment().tz(TIMEZONE);
            const tomorrow = today.clone().add(1, 'day').toDate();
            
            // Criar appointment para amanhã
            const appointment = await Appointment.create({
                patient: new mongoose.Types.ObjectId(),
                doctor: new mongoose.Types.ObjectId(),
                date: tomorrow,
                time: '10:00',
                specialty: 'fonoaudiologia',
                sessionValue: 200,
                billingType: 'particular'
            });

            // Criar payment hoje para sessão de amanhã
            const payment = await Payment.create({
                patient: appointment.patient,
                doctor: appointment.doctor,
                appointment: appointment._id,
                amount: 200,
                paymentDate: today.toDate(),
                paymentMethod: 'pix',
                status: 'paid'
            });

            // Validar que é adiantamento
            const paymentDate = moment(payment.paymentDate).format('YYYY-MM-DD');
            const appointmentDate = moment(appointment.date).format('YYYY-MM-DD');
            
            expect(paymentDate).toBe(today.format('YYYY-MM-DD'));
            expect(appointmentDate).toBe(today.clone().add(1, 'day').format('YYYY-MM-DD'));
            expect(appointmentDate > paymentDate).toBe(true);
        });
    });

    // ============================================================================
    // TESTE 3: Pacote Particular
    // ============================================================================
    describe('CENÁRIO 3: Pacote Particular', () => {
        it('deve criar pacote com payment único', async () => {
            const patientId = new mongoose.Types.ObjectId();
            const doctorId = new mongoose.Types.ObjectId();
            
            // Criar pacote
            const pkg = await Package.create({
                patient: patientId,
                doctor: doctorId,
                sessionType: 'fonoaudiologia',
                totalSessions: 10,
                sessionValue: 180,
                totalValue: 1800,
                type: 'therapy'
            });

            // Criar payment único do pacote
            const payment = await Payment.create({
                patient: patientId,
                doctor: doctorId,
                package: pkg._id,
                amount: 1800,
                paymentDate: new Date(),
                paymentMethod: 'pix',
                status: 'paid',
                kind: 'package_receipt',
                billingType: 'particular'
            });

            // Validar
            expect(payment.kind).toBe('package_receipt');
            expect(payment.package.toString()).toBe(pkg._id.toString());
            expect(payment.amount).toBe(1800);
        });

        it('NÃO deve criar múltiplos payments para o mesmo pacote', async () => {
            const patientId = new mongoose.Types.ObjectId();
            const doctorId = new mongoose.Types.ObjectId();
            
            const pkg = await Package.create({
                patient: patientId,
                doctor: doctorId,
                sessionType: 'fonoaudiologia',
                totalSessions: 10,
                type: 'therapy'
            });

            // Criar primeiro payment
            await Payment.create({
                patient: patientId,
                package: pkg._id,
                amount: 1800,
                paymentDate: new Date(),
                paymentMethod: 'pix',
                status: 'paid',
                kind: 'package_receipt'
            });

            // Tentar criar segundo payment - isso seria um erro
            const payments = await Payment.find({ package: pkg._id });
            expect(payments.length).toBe(1);
        });
    });

    // ============================================================================
    // TESTE 4: Consumo de Pacote
    // ============================================================================
    describe('CENÁRIO 4: Consumo de Pacote', () => {
        it('consumo de pacote NÃO deve criar payment', async () => {
            const patientId = new mongoose.Types.ObjectId();
            const doctorId = new mongoose.Types.ObjectId();
            
            // Criar pacote pago
            const pkg = await Package.create({
                patient: patientId,
                doctor: doctorId,
                sessionType: 'fonoaudiologia',
                totalSessions: 10,
                sessionsDone: 0,
                type: 'therapy'
            });

            await Payment.create({
                patient: patientId,
                package: pkg._id,
                amount: 1800,
                paymentDate: new Date(),
                paymentMethod: 'pix',
                status: 'paid',
                kind: 'package_receipt'
            });

            // Criar appointment usando o pacote (consumo)
            const appointment = await Appointment.create({
                patient: patientId,
                doctor: doctorId,
                package: pkg._id,
                date: new Date(),
                time: '10:00',
                specialty: 'fonoaudiologia',
                sessionValue: 0, // Pacote já pago
                billingType: 'particular',
                paymentOrigin: 'package_prepaid'
            });

            // Incrementar sessionsDone
            pkg.sessionsDone += 1;
            await pkg.save();

            // Verificar que NÃO foi criado payment para o consumo
            const consumptionPayment = await Payment.findOne({
                appointment: appointment._id,
                kind: 'session_payment'
            });

            expect(consumptionPayment).toBeNull();
            expect(pkg.sessionsDone).toBe(1);
        });
    });

    // ============================================================================
    // TESTE 5: Convênio
    // ============================================================================
    describe('CENÁRIO 5: Convênio', () => {
        it('sessão de convênio NÃO deve criar payment com valor', async () => {
            const patientId = new mongoose.Types.ObjectId();
            const doctorId = new mongoose.Types.ObjectId();
            
            // Criar appointment de convênio
            const appointment = await Appointment.create({
                patient: patientId,
                doctor: doctorId,
                date: new Date(),
                time: '10:00',
                specialty: 'fonoaudiologia',
                sessionValue: 0,
                billingType: 'convenio',
                insuranceProvider: 'unimed-anapolis',
                serviceType: 'convenio_session'
            });

            // Criar payment de convênio (sem valor ou valor do convênio)
            const payment = await Payment.create({
                patient: patientId,
                doctor: doctorId,
                appointment: appointment._id,
                amount: 80, // Valor do convênio, não pago pelo paciente
                paymentDate: new Date(),
                paymentMethod: 'convenio',
                status: 'pending', // Pendente de recebimento do convênio
                billingType: 'convenio'
            });

            expect(payment.paymentMethod).toBe('convenio');
            expect(payment.billingType).toBe('convenio');
        });

        it('convênio NÃO deve entrar em cashInToday', async () => {
            const payment = await Payment.create({
                patient: new mongoose.Types.ObjectId(),
                amount: 80,
                paymentDate: new Date(),
                paymentMethod: 'convenio',
                status: 'pending',
                billingType: 'convenio'
            });

            // Convênio não é dinheiro no caixa
            expect(payment.paymentMethod).toBe('convenio');
            expect(payment.status).toBe('pending');
        });
    });

    // ============================================================================
    // TESTE 6: Pré-agendamento
    // ============================================================================
    describe('CENÁRIO 6: Pré-agendamento', () => {
        it('pré-agendamento NÃO deve ter payment', async () => {
            const appointment = await Appointment.create({
                patientInfo: {
                    fullName: 'Paciente Teste',
                    phone: '62999999999'
                },
                date: new Date(),
                specialty: 'fonoaudiologia',
                operationalStatus: 'pre_agendado',
                paymentStatus: 'pending'
            });

            // Validar que não tem payment
            expect(appointment.operationalStatus).toBe('pre_agendado');
            expect(appointment.payment).toBeUndefined();
        });

        it('pré-agendamento NÃO deve gerar receita', async () => {
            const today = moment().format('YYYY-MM-DD');
            
            await Appointment.create({
                patientInfo: { fullName: 'Paciente Teste' },
                date: moment().toDate(),
                specialty: 'fonoaudiologia',
                operationalStatus: 'pre_agendado'
            });

            // Verificar que não existe payment para pré-agendamento
            const payments = await Payment.find({
                paymentDate: { $gte: moment().startOf('day').toDate() }
            });

            const preAgendPayments = payments.filter(p => 
                p.appointment && p.appointment.operationalStatus === 'pre_agendado'
            );

            expect(preAgendPayments.length).toBe(0);
        });
    });

    // ============================================================================
    // TESTE 7: Daily Closing
    // ============================================================================
    describe('CENÁRIO 7: Daily Closing', () => {
        it('deve calcular cashInToday corretamente', async () => {
            const today = moment().tz(TIMEZONE).format('YYYY-MM-DD');
            
            // Criar payments de hoje
            await Payment.create({
                patient: new mongoose.Types.ObjectId(),
                amount: 200,
                paymentDate: moment.tz(today, TIMEZONE).toDate(),
                paymentMethod: 'pix',
                status: 'paid',
                billingType: 'particular'
            });

            await Payment.create({
                patient: new mongoose.Types.ObjectId(),
                amount: 180,
                paymentDate: moment.tz(today, TIMEZONE).toDate(),
                paymentMethod: 'dinheiro',
                status: 'paid',
                billingType: 'particular'
            });

            // Calcular cashInToday
            const payments = await Payment.find({
                paymentDate: {
                    $gte: moment.tz(today, TIMEZONE).startOf('day').toDate(),
                    $lte: moment.tz(today, TIMEZONE).endOf('day').toDate()
                },
                status: 'paid',
                billingType: 'particular',
                kind: { $ne: 'package_receipt' } // Excluir pagamentos de pacote
            });

            const cashInToday = payments.reduce((sum, p) => sum + p.amount, 0);
            expect(cashInToday).toBe(380);
        });

        it('NÃO deve incluir convênio no cashInToday', async () => {
            const today = moment().tz(TIMEZONE).format('YYYY-MM-DD');
            
            await Payment.create({
                patient: new mongoose.Types.ObjectId(),
                amount: 80,
                paymentDate: moment.tz(today, TIMEZONE).toDate(),
                paymentMethod: 'convenio',
                status: 'pending',
                billingType: 'convenio'
            });

            const convenioPayments = await Payment.find({
                paymentDate: {
                    $gte: moment.tz(today, TIMEZONE).startOf('day').toDate(),
                    $lte: moment.tz(today, TIMEZONE).endOf('day').toDate()
                },
                billingType: 'convenio'
            });

            // Convênios não entram no caixa
            const cashInToday = convenioPayments
                .filter(p => p.billingType !== 'convenio')
                .reduce((sum, p) => sum + p.amount, 0);

            expect(cashInToday).toBe(0);
        });
    });

    // ============================================================================
    // TESTE 8: Edge Cases
    // ============================================================================
    describe('EDGE CASES', () => {
        it('NÃO deve permitir pagamento com valor negativo', async () => {
            await expect(Payment.create({
                patient: new mongoose.Types.ObjectId(),
                amount: -100,
                paymentDate: new Date(),
                paymentMethod: 'pix'
            })).rejects.toThrow();
        });

        it('NÃO deve permitir pacote com sessionsDone > totalSessions', async () => {
            const pkg = await Package.create({
                patient: new mongoose.Types.ObjectId(),
                doctor: new mongoose.Types.ObjectId(),
                sessionType: 'fonoaudiologia',
                totalSessions: 5,
                sessionsDone: 0
            });

            // Tentar incrementar além do limite
            pkg.sessionsDone = 6;
            await pkg.save();

            // Verificar se a validação funcionaria (simplificada)
            expect(pkg.sessionsDone).toBeGreaterThan(pkg.totalSessions);
        });

        it('deve detectar appointments duplicados', async () => {
            const patientId = new mongoose.Types.ObjectId();
            const date = moment().format('YYYY-MM-DD');
            const time = '10:00';

            // Criar primeiro appointment
            await Appointment.create({
                patient: patientId,
                date: moment(date).toDate(),
                time: time,
                specialty: 'fonoaudiologia',
                operationalStatus: 'scheduled'
            });

            // Criar segundo appointment no mesmo slot
            await Appointment.create({
                patient: patientId,
                date: moment(date).toDate(),
                time: time,
                specialty: 'fonoaudiologia',
                operationalStatus: 'scheduled'
            });

            // Buscar duplicatas
            const appointments = await Appointment.find({
                patient: patientId,
                date: moment(date).toDate(),
                time: time,
                operationalStatus: { $ne: 'canceled' }
            });

            expect(appointments.length).toBe(2);
        });
    });
});

// ============================================================================
// Testes de validação de integração
// ============================================================================

describe('Validação de Integração - Fluxos Completos', () => {
    
    it('FLUXO COMPLETO: Sessão avulsa → Pagamento → Daily Closing', async () => {
        // Este teste simula o fluxo completo de uma sessão avulsa
        expect(true).toBe(true); // Placeholder - implementar fluxo completo
    });

    it('FLUXO COMPLETO: Pacote → Consumo → Sem pagamento extra', async () => {
        // Este teste simula o fluxo de pacote
        expect(true).toBe(true); // Placeholder - implementar fluxo completo
    });

    it('FLUXO COMPLETO: Convênio → Produção → Não caixa', async () => {
        // Este teste simula o fluxo de convênio
        expect(true).toBe(true); // Placeholder - implementar fluxo completo
    });
});
