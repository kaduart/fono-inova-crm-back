import mongoose from 'mongoose';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import { FinancialContext } from '../utils/financialContext.js';
import { saveToOutbox } from '../infrastructure/outbox/outboxPattern.js';
import { resolvePaymentKind } from '../utils/resolvePaymentKind.js';
import AppointmentWriteGuard from '../services/appointment/AppointmentWriteGuard.js';
import crypto from 'crypto';

const paymentSchema = new mongoose.Schema({
    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
    patientId: { type: String, index: true }, // 🎯 Compatibilidade V2
    doctor: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor' },
    appointment: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', default: null },
    appointmentId: { type: String, index: true }, // 🎯 Compatibilidade V2
    session: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', default: null },
    package: { type: mongoose.Schema.Types.ObjectId, ref: 'Package', default: null },
    liminarContract: { type: mongoose.Schema.Types.ObjectId, ref: 'LiminarContract', default: null },
    sessions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Session' }],
    advanceSessions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Session' }],
    amount: { type: Number, required: true, min: 0 },
    paymentDate: { type: Date, required: true },
    serviceDate: { type: Date, default: null },
    paymentMethod: {
        type: String,
        enum: ['pix', 'cartão', 'dinheiro', 'convenio', 'liminar_credit', 'credit_card', 'debit_card', 'cash', 'bank_transfer', 'other', 'credito', 'debito', 'cartao_credito', 'cartao_debito', 'transferencia', 'transferencia_bancaria'],
        required: true
    },
    status: {
        type: String,
        enum: ['pending', 'pending_billing', 'billed', 'partial', 'paid', 'canceled', 'refunded', 'converted_to_package', 'recognized', 'consumed'],
        default: 'pending'
    },
    serviceType: { type: String, default: null },
    sessionType: { type: String, default: null },
    kind: {
        type: String,
        enum: ['package_receipt', 'revenue_recognition', 'session_payment', 'appointment_payment', 'package_consumed', 'monthly_settlement', 'debt_settlement', 'package_payment', 'manual_adjustment', 'unknown_or_orphan', 'liminar_contract_receipt', null],
        default: null
    },
    // 🎯 PAPEL dentro de uma consulta particular parcelada em sinal + saldo (ver
    // back/domain/payment/depositBalance.js). Eixo ortogonal a `kind` (que descreve
    // a NATUREZA do Payment — sessão avulsa/pacote/quitação — não seu PAPEL dentro
    // de uma mesma obrigação parcelada). `kind` continua 'session_payment' nos três
    // valores. 'standard' = comportamento legado (1 Payment cobre a consulta inteira,
    // sem sinal). Ver back/docs/FINANCIAL_SOURCE_OF_TRUTH.md#payment-role.
    paymentRole: {
        type: String,
        enum: ['standard', 'deposit', 'balance'],
        default: 'standard'
    },
    kindConfidence: {
        type: String,
        enum: ['high', 'medium', 'low', null],
        default: null
    },
    kindSource: {
        type: String,
        default: null
    },
    settledPaymentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Payment', default: [] }],
    bulkSettlementKey: { type: String, default: null, index: true },
    billingType: {
        type: String,
        enum: ['particular', 'convenio', 'insurance', 'liminar'],
        required: false,
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
    financialDate: { type: Date, default: null, index: true },
    parentPaymentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Payment',
        default: null,
        description: 'ID do payment original quando este for criado por remarcação'
    },
    isFromPackage: {
        type: Boolean,
        default: false,
        description: 'True quando o payment representa consumo de crédito de pacote (não é entrada de caixa)'
    },
    insurance: {
        provider: { type: String, default: null },
        authorizationCode: { type: String, default: null },
        insuranceProvider: { type: mongoose.Schema.Types.ObjectId, ref: 'Convenio', default: null },
        guideNumber: { type: String, default: null },
        month: { type: String, default: null },
        status: {
            type: String,
            enum: ['pending', 'pending_billing', 'billed', 'received', 'rejected', null],
            default: 'pending'
        },
        grossAmount: { type: Number, default: 0 },
        netAmount: { type: Number, default: 0 },
        // Valor efetivamente creditado no recebimento (pode divergir de grossAmount por glosa,
        // pagamento parcial ou retenção de imposto — ver issRate/issAmount abaixo)
        receivedAmount: { type: Number, default: 0 },
        // Alíquota (%) e valor de imposto retido na fonte pelo convênio (ex: ISS Unimed), aplicados
        // automaticamente no recebimento a partir de Convenio.issRate — snapshot da alíquota vigente
        issRate: { type: Number, default: 0 },
        issAmount: { type: Number, default: 0 },
        billedAt: { type: Date, default: null },
        receivedAt: { type: Date, default: null },
        billedAtSource: { type: String, default: null },
        receivedAtSource: { type: String, default: null }
    },
    insuranceGuide: { type: mongoose.Schema.Types.ObjectId, ref: 'InsuranceGuide', default: null },
    insurancePlan:  { type: mongoose.Schema.Types.ObjectId, ref: 'InsurancePlan',  default: null },
    splitGroupId: {
        type: String,
        default: null,
        index: true,
        description: 'ID de grupo para vincular payments de um mesmo split (multi-forma)'
    },
    splitMethods: [{
        method: {
            type: String,
            enum: ['pix', 'cartão', 'dinheiro', 'bank_transfer', 'outro', 'credit_card', 'debit_card', 'other'],
        },
        amount: { type: Number, min: 0 },
        date: { type: Date, default: null }
    }],
    source: {
        type: String,
        default: null,
        description: 'Origem/fluxo que gerou o payment (ex: appointment_split, complete_session, manual_entry)'
    },
    // 🛡️ INTEGRITY STATUS: rastreabilidade de payments cujo vínculo com Patient
    // foi perdido por deleção antiga sem cascade ou por inconsistência histórica.
    // Usado pela auditoria para distinguir órfãos novos de registros já tratados.
    integrityStatus: {
        type: String,
        enum: ['healthy', 'relinked', 'legacy_patient_deleted', 'manual_review', null],
        default: null,
        index: true,
        description: 'healthy=consistente, relink=vínculo recuperado, legacy_patient_deleted=paciente deletado, manual_review=precisa de revisão humana'
    },
    integrityMetadata: {
        detectedAt: { type: Date, default: null },
        originalPatientId: { type: String, default: null },
        originalPatientName: { type: String, default: null },
        reason: { type: String, default: null },
        notes: { type: String, default: null },
        treatedAt: { type: Date, default: null },
        treatedBy: { type: String, default: null }
    }
}, { timestamps: true });

// ============ SCHEMA GUARD - PROTEÇÃO CONSISTÊNCIA ============
paymentSchema.pre('validate', function(next) {
    // 🎯 AUTO-PREENCHIMENTO: Garante consistência
    
    // billingType SEMPRE deve existir
    if (!this.billingType) {
        this.billingType = 'particular';
    }
    
    // patientId sempre string do patient
    if (this.patient && !this.patientId) {
        this.patientId = this.patient.toString();
    }
    
    // appointmentId sempre string do appointment
    if (this.appointment && !this.appointmentId) {
        this.appointmentId = this.appointment.toString();
    }
    
    // financialDate para payments pagos — paidAt é predominante (momento real do pagamento)
    if (['paid', 'completed', 'confirmed'].includes(this.status) && !this.financialDate && !this.isFromPackage) {
        this.financialDate = this.paidAt || this.paymentDate || new Date();
    }
    
    // 🚨 GUARDA FINANCEIRA: package_consumed SEMPRE é consumo de pacote
    if (this.kind === 'package_consumed' && !this.isFromPackage) {
        this.isFromPackage = true;
    }
    
    // 🚨 GUARDA FINANCEIRA: consumo de pacote NUNCA pode ter paidAt
    if ((this.isFromPackage || this.kind === 'package_consumed') && this.paidAt) {
        this.paidAt = null;
    }

    // 🔒 ENFORCEMENT: Payment.kind nunca pode ficar null
    if (!this.kind) {
        const inferred = resolvePaymentKind(this);

        if (inferred.kind === 'unknown_or_orphan' && inferred.confidence === 'low') {
            const error = new Error(
                `[PAYMENT_KIND_ENFORCEMENT] Não foi possível inferir kind para o payment. Payment precisa de session, appointment, package ou descrição explícita.`
            );
            error.code = 'PAYMENT_KIND_UNKNOWN';
            return next(error);
        }

        this.kind = inferred.kind;
        this.kindConfidence = inferred.confidence;
        this.kindSource = 'inferred_on_validate';

        console.log('[PaymentKindEnforcement] kind inferido:', {
            paymentId: this._id,
            kind: this.kind,
            confidence: this.kindConfidence,
            reason: inferred.reason,
            patient: this.patient,
            appointment: this.appointment,
            session: this.session,
            package: this.package
        });
    }

    next();
});

// ============ BLINDAGEM FINANCEIRA ============
paymentSchema.pre('save', async function(next) {
    // 🎯 CAPTURA STATUS ANTES de qualquer modificação (para safety net post-save)
    if (!this.isNew && this.isModified('status')) {
        this.$locals.previousStatus = this.$locals.previousStatus || this._doc.status;
    }

    const ctx = FinancialContext.get();
    if (ctx === 'session' || ctx === 'appointment') {
        console.error(`[SECURITY BLOCK] Tentativa de save em Payment por ${ctx} bloqueada`);
        throw new Error(`[SECURITY] ${ctx} não pode criar/atualizar Payment diretamente`);
    }
    
    // 🚨 GUARDA FINANCEIRA: consumo de pacote NUNCA pode ter status 'paid' nem paidAt
    if ((this.isFromPackage || this.kind === 'package_consumed')) {
        if (this.status === 'paid') {
            this.status = 'consumed';
        }
        if (this.paidAt) {
            this.paidAt = null;
        }
    }
    
    if (this.status === 'paid' && !this.paidAt) {
        const error = new Error(
            `[FINANCIAL LOCK] paidAt é obrigatório quando status='paid'. `
        );
        error.code = 'MISSING_PAID_AT';
        return next(error);
    }
    
    if (['paid', 'completed', 'confirmed'].includes(this.status)) {
        if (!this.financialDate && !this.isFromPackage) {
            this.financialDate = this.createdAt || new Date();
        }
    }
    
    // 🚨 GUARDA FINANCEIRA: consumo de pacote NUNCA deve ter financialDate
    if (this.isFromPackage && this.financialDate) {
        const error = new Error(
            `[FINANCIAL_LOCK] Payment de consumo de pacote (isFromPackage=true) não pode ter financialDate. `
        );
        error.code = 'PACKAGE_PAYMENT_CANNOT_HAVE_FINANCIAL_DATE';
        return next(error);
    }
    
    // 🚨 GUARDA LEGADO: prepaid foi removido do domínio
    if (this.billingType === 'prepaid') {
        console.error('[FINANCIAL_GUARD] billingType=prepaid detectado — tipo removido do domínio', {
            paymentId: this._id,
            patient: this.patient,
            amount: this.amount
        });
        const error = new Error(`[FINANCIAL_LOCK] billingType='prepaid' foi removido do domínio. Use isFromPackage=true + paymentMethod='package'.`);
        error.code = 'PREPAID_BILLING_TYPE_DEPRECATED';
        return next(error);
    }
    
    next();
});

// ============ ÍNDICES DE PERFORMANCE (ledger multi-entry) ============
paymentSchema.index({ appointment: 1, splitGroupId: 1, status: 1 }, { name: 'ledger_split_lookup' });
paymentSchema.index({ source: 1, createdAt: -1 }, { name: 'source_audit_trail' });

// ============ SAFETY NET: Emite evento se status mudou via save() direto ============
// Detecta bypass de transitionPaymentStatus e emite evento automaticamente.
// O snapshot worker V2 tem idempotência via processedEvents, então duplicatas são seguras.
paymentSchema.post('save', async function(doc) {
    const previousStatus = doc.$locals?.previousStatus;
    const currentStatus = doc.status;

    if (!previousStatus || previousStatus === currentStatus) {
        return;
    }

    // Se transitionPaymentService já emitiu, pula
    if (doc.__statusChangedEmitted) {
        return;
    }

    try {
        await publishEvent(
            EventTypes.PAYMENT_STATUS_CHANGED,
            {
                paymentId: doc._id.toString(),
                patientId: doc.patient?.toString?.(),
                appointmentId: doc.appointment?.toString?.(),
                sessionId: doc.session?.toString?.(),
                packageId: doc.package?.toString?.(),
                from: previousStatus,
                to: currentStatus,
                amount: doc.amount,
                paymentMethod: doc.paymentMethod,
                financialDate: doc.financialDate,
                paidAt: doc.paidAt,
                kind: doc.kind,
                billingType: doc.billingType,
                isFromPackage: doc.isFromPackage,
                reason: 'post_save_safety_net',
                userId: null,
                _safetyNet: true  // marca como evento de segurança
            },
            {
                correlationId: `safety_net_${doc._id}_${previousStatus}_${currentStatus}_${Date.now()}`,
                idempotencyKey: `${doc._id}_${previousStatus}_${currentStatus}_${new Date().toISOString().split('T')[0]}`,
                aggregateType: 'payment',
                aggregateId: doc._id.toString(),
                metadata: { source: 'Payment.post_save_safety_net', autoEmitted: true }
            }
        );
        console.log(`[Payment Safety Net] ${doc._id}: ${previousStatus} → ${currentStatus} (evento emitido automaticamente)`);
    } catch (err) {
        console.error(`[Payment Safety Net] Falha ao emitir evento: ${err.message}`, {
            paymentId: doc._id,
            from: previousStatus,
            to: currentStatus
        });
    }
});

// ============ INDEXES PARA PERFORMANCE ============
paymentSchema.index({ status: 1, billingType: 1, paymentDate: -1 });
paymentSchema.index({ financialDate: -1, status: 1 });
paymentSchema.index({ patientId: 1, status: 1 });

// 💰 Índices para dashboards financeiros V2 (cash / production / receivables)
paymentSchema.index({ status: 1, financialDate: -1, amount: 1, kind: 1 }, { name: 'financial_cash_status_date' });
paymentSchema.index({ status: 1, doctor: 1, financialDate: -1 }, { name: 'financial_doctor_cash_status_date' });

// 💰 Índices para pendentes / a receber — filtro por status + data (serviceDate como fallback)
paymentSchema.index({ status: 1, serviceDate: -1 }, { name: 'pendentes_status_serviceDate' });

// 💰 Cobertura dos ramos de fallback do calculateCashTotal ($or com paymentDate/createdAt)
// Ramo 2/3: financialDate=null → paymentDate como data primária (legado)
paymentSchema.index({ status: 1, paymentDate: -1 }, { name: 'cash_status_paymentDate' });

// 🛡️ AIRBAG: 1 Payment ATIVO por (appointment + billingType + paymentRole)
// Impede double-counting estrutural independente da lógica de aplicação.
// partial: só aplica quando appointment existe e status != cancelled/canceled.
//
// 🎯 Estendido em 2026-09-04 (feature sinal+saldo) de {appointment,billingType}
// para incluir `paymentRole`: antes só existia 1 Payment ativo por consulta
// particular; agora podem existir 2 — um 'deposit' (sinal, pago no
// pré-agendamento) e um 'balance'/'standard' (saldo, liquidado no atendimento)
// — mas nunca 2 do MESMO papel. A garantia "nunca duplica" não foi removida,
// só teve seu escopo redesenhado. Ver back/scripts/migrations/2026-09-04-payment-role-deposit-balance.js
// para o backfill+troca de índice em produção, e back/domain/payment/depositBalance.js
// para quem cria/busca por papel.
// ⚠️ DOIS problemas confirmados em 2026-09-04 rodando esta migração contra um
// mongod real (não só lidos na documentação — reproduzidos com erro código 67
// CannotCreateIndex):
//   1. `sparse` + `partialFilterExpression` juntos são REJEITADOS pelo MongoDB
//      ("cannot mix partialFilterExpression and sparse options").
//   2. `$ne`/`$nin` NÃO são operadores suportados em partialFilterExpression
//      ("Expression not supported in partial index: $not"). Só $eq, $exists,
//      $gt/$gte/$lt/$lte, $type e $and (topo) são suportados.
// O índice ANTERIOR (`unique_active_payment_per_appt_billingtype`, removido
// nesta mudança) tinha AMBOS os problemas — ou seja, é muito provável que
// nunca tenha sido de fato criado em produção, só declarado no schema (mesma
// classe de risco documentada em
// scripts/migrations/2026-08-26-financial-ledger-reversal-index.js: "índice
// declarado no schema local, mas ainda não existe em produção"). Corrigido
// aqui com o mesmo padrão já usado (e funcional) no índice irmão
// `unique_active_convenio_payment_per_session` logo abaixo: `$type` em vez de
// `$exists+$ne`, e `$in` (allowlist positiva) em vez de `$nin`.
paymentSchema.index(
    { appointment: 1, billingType: 1, paymentRole: 1 },
    {
        unique: true,
        partialFilterExpression: {
            appointment: { $type: 'objectId' },
            status: { $in: ['pending', 'pending_billing', 'billed', 'partial', 'paid', 'refunded', 'converted_to_package', 'recognized', 'consumed'] }
        },
        name: 'unique_active_payment_per_appt_billingtype_role'
    }
);

// 🛡️ AIRBAG PR-A: 1 Payment ativo de convênio por Session.
// Garante a regra de ouro do domínio: uma sessão de convênio gera um único
// recebível ativo. O índice é parcial para não afetar payments cancelados,
// particulares, pacotes, sessions nulas ou histórico legado.
//
// Nota: $ne: null não é suportado em partialFilterExpression do MongoDB;
//       $type: 'objectId' cobre a mesma necessidade (só indexa ObjectIds).
paymentSchema.index(
    { session: 1, billingType: 1 },
    {
        unique: true,
        partialFilterExpression: {
            session: { $type: 'objectId' },
            billingType: 'convenio',
            status: { $in: ['pending', 'pending_billing', 'billed', 'received', 'paid', 'partial'] }
        },
        name: 'unique_active_convenio_payment_per_session'
    }
);
// Ramo 4/5: sem financialDate nem paymentDate → createdAt como último fallback
paymentSchema.index({ status: 1, createdAt: -1 }, { name: 'cash_status_createdAt' });
paymentSchema.index({ _billingEventId: 1 }, { sparse: true, name: 'billing_event_lock' });

// 🛡️ Auditoria de integridade: só lista órfãos não tratados
paymentSchema.index({ integrityStatus: 1, patient: 1, appointment: 1 }, { name: 'integrity_audit_orphans', sparse: true });

// ============ MÉTODOS ============
paymentSchema.methods.toDTO = function() {
    return {
        id: this._id,
        patientId: this.patientId || this.patient?.toString(),
        appointmentId: this.appointmentId || this.appointment?.toString(),
        amount: this.amount,
        status: this.status,
        billingType: this.billingType,
        paymentMethod: this.paymentMethod,
        paymentDate: this.paymentDate,
        financialDate: this.financialDate,
        paidAt: this.paidAt
    };
};

// 🛡️ Flags de autorização do AppointmentWriteGuard — ver Appointment.js para o
// racional completo (strict mode do Mongoose descarta campos não declarados em
// updates via Model.findByIdAndUpdate/findOneAndUpdate).
paymentSchema.add({
  _fromCompleteService: { type: Boolean, select: false },
  _fromCancelService: { type: Boolean, select: false },
  _fromWriteGateway: { type: Boolean, select: false },
  _fromInsuranceOrchestrator: { type: Boolean, select: false },
  // Autoriza transitionPaymentStatus() (services/paymentStatusService.js) —
  // a ÚNICA via canônica de mudar Payment.status (DOMAIN_INVARIANTS.md #9).
  // Sem esta flag, TODA chamada legítima (13+ call sites em produção) gerava
  // WARN de "write não autorizado" — achado em 2026-08-26 validando o
  // recebimento real da NF #124.
  _fromPaymentStatusService: { type: Boolean, select: false },
});

const Payment = mongoose.model('Payment', paymentSchema);

// 🛡️ Instala interceptor de writes raw no model Payment
AppointmentWriteGuard.install('Payment', Payment, ['status']);

export default Payment;
