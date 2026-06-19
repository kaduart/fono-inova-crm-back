// models/Session.js
import mongoose from 'mongoose';
import { syncEvent } from '../services/syncService.js';
import provisionamentoService from '../services/provisionamentoService.js';
import MedicalEvent from './MedicalEvent.js';
import financialSanitizer from './plugins/financialSanitizer.js';

const sessionSchema = new mongoose.Schema({
    date: {
        type: Date,
        set: function(v) {
            // Se for string "YYYY-MM-DD", converte para Date
            if (typeof v === 'string' && v.match(/^\d{4}-\d{2}-\d{2}$/)) {
                const [ano, mes, dia] = v.split('-').map(Number);
                return new Date(Date.UTC(ano, mes - 1, dia, 12, 0, 0));
            }
            return v;
        }
    },
    time: String,
    sessionType: {
        type: String,
        required: [true, 'sessionType é obrigatório'],
        enum: {
            values: [
                'fonoaudiologia',
                'psicologia', 
                'terapia ocupacional',
                'fisioterapia',
                'pediatria',
                'neuroped',
                'musicoterapia',
                'psicomotricidade',
                'psicopedagogia',
                'neuropsicologia'
            ],
            message: 'sessionType "{VALUE}" não é válido. Use: fonoaudiologia, psicologia, terapia ocupacional, etc'
        },
        set: function(v) {
            // Normaliza: lowercase, trim, underscores viram espaço, remove espaços duplos
            // 'terapia_ocupacional' → 'terapia ocupacional'
            // 'Fonoaudiologia' → 'fonoaudiologia'
            if (!v) return v;
            return v.toString().toLowerCase().trim().replace(/_/g, ' ').replace(/\s+/g, ' ');
        }
    },
    sessionValue: Number,
    appointmentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Appointment',
        default: null,
        required: false
    },
    doctor: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Doctor', // String, não importe o modelo aqui!
        required: true
    },
    patient: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Patient',
        required: true
    },
    package: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Package', // String
    },
    isPaid: { type: Boolean, default: false },
    paymentMethod: {
        type: String,
        enum: ['dinheiro', 'pix', 'cartão', 'convenio', 'liminar_credit', 'credito', 'debito', 'cartao_credito', 'cartao_debito', 'transferencia', 'transferencia_bancaria'],
        default: null
    },
    session: String,
    status: {
        type: String,
        enum: {
            values: ['pending', 'completed', 'canceled', 'scheduled'],
            message: 'Status inválido para sessão'
        },
    },
    completedAt: { type: Date, default: null },
    confirmedAbsence: { type: Boolean, default: null },
    notes: { type: String },
    paymentStatus: {
        type: String,
        enum: ['paid', 'partial', 'pending', 'unpaid', 'pending_receipt', 'recognized', 'package_paid', 'pending_balance'],
        default: 'pending',
        description: 'Situação financeira específica desta sessão'
    },

    partialAmount: {
        type: Number,
        default: 0,
        description: 'Valor pago parcialmente nesta sessão (se aplicável)'
    },

    visualFlag: {
        type: String,
        enum: ['ok', 'pending', 'blocked'],
        default: 'pending',
        description: 'Indica o estado visual da sessão para exibição no calendário'
    },
    originalPartialAmount: {
        type: Number,
        description: 'Valor original pago antes do cancelamento'
    },
    originalPaymentStatus: {
        type: String,
        enum: ['paid', 'partial', 'pending'],
        description: 'Status de pagamento original'
    },
    originalPaymentMethod: {
        type: String,
        enum: ['dinheiro', 'pix', 'cartão', 'convenio', 'liminar_credit'], // ← Adicionado 'convenio' e 'liminar_credit'
        description: 'Método de pagamento original'
    },
    originalIsPaid: {
        type: Boolean,
        description: 'Flag de pagamento original'
    },
    canceledAt: {
        type: Date,
        description: 'Data do cancelamento'
    },
    insuranceGuide: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'InsuranceGuide',
        default: null,
        description: 'Guia de convênio vinculada a esta sessão'
    },
    guideConsumed: {
        type: Boolean,
        default: false,
        description: 'Flag de idempotência - true se a guia já foi consumida'
    },
    billingBatchId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'InsuranceBatch',
        default: null,
        description: 'Lote de faturamento ao qual esta sessão foi vinculada'
    },
    paidAt: {
        type: Date,
        default: null,
        description: 'Data do recebimento do pagamento (para cash flow)'
    },
    paymentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Payment',
        default: null,
        description: 'Referência ao Payment associado (futuro: unificação financeira)'
    },

    // 🏥 Insurance Billing V2: idempotência e rastreabilidade
    insuranceBillingProcessed: {
        type: Boolean,
        default: false,
        description: 'Flag de idempotência: true se a sessão já gerou billing/payment'
    },
    insuranceBillingProcessedAt: {
        type: Date,
        default: null,
        description: 'Momento do processamento do insurance billing'
    },
    insuranceAppointmentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Appointment',
        default: null,
        description: 'Appointment V2 gerado a partir da sessão'
    },
    _billingEventId: {
        type: String,
        default: null,
        description: 'Correlation ID do último evento de billing processado'
    },

    // ⭐ CAMPOS PARA ARQUITETURA FINANCEIRA ROBUSTA
    
    sessionConsumed: {
        type: Boolean,
        default: false,
        description: 'Define se a sessão consome do pacote/saldo (true para completed/missed, false para canceled)'
    },
    
    commissionRate: {
        type: Number,
        default: null,
        description: 'LEGADO: Percentual de comissão do profissional. Não usar como fonte de verdade.'
    },

    commissionValue: {
        type: Number,
        default: null,
        description: 'LEGADO: Valor calculado da comissão. Não usar como fonte de verdade.'
    },

    // 🆕 Snapshot da comissão aplicada no momento do complete
    commissionSnapshot: {
        ruleId: {
            type: mongoose.Schema.Types.ObjectId,
            default: null,
            description: 'ID da regra de comissão aplicada'
        },
        version: {
            type: Number,
            default: null,
            description: 'Versão das regras de comissão no momento do cálculo'
        },
        commissionType: {
            type: String,
            enum: ['fixed', 'percentage', null],
            default: null
        },
        value: {
            type: Number,
            default: null,
            description: 'Valor bruto da regra (R$ ou %)'
        },
        minValue: {
            type: Number,
            default: null,
            description: 'Valor mínimo da sessão para aplicação da regra'
        },
        maxValue: {
            type: Number,
            default: null,
            description: 'Valor máximo da sessão para aplicação da regra'
        },
        effectiveDate: {
            type: Date,
            default: null,
            description: 'Data de vigência da regra no momento do snapshot'
        },
        calculatedCommission: {
            type: Number,
            default: null,
            description: 'Valor final da comissão calculada para esta sessão'
        },
        calculatedAt: {
            type: Date,
            default: null
        },
        migrated: {
            type: Boolean,
            default: false,
            description: 'Indica se o snapshot foi gerado por backfill/migração'
        },
        migratedAt: {
            type: Date,
            default: null
        },
        originalRuleVersion: {
            type: Number,
            default: null,
            description: 'Versão das regras de comissão vigente na época da migração'
        }
    },
    
    statusHistory: [{
        status: { type: String },
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
    }],
    
    revenueRecognizedAt: {
        type: Date,
        default: null,
        description: 'Data em que a receita foi reconhecida (para DRE mensal)'
    },
    
    // 🆕 ARQUITETURA v4.0 - Rastreabilidade Financeira
    paymentOrigin: {
        type: String,
        enum: ['auto_per_session', 'manual_balance', 'package_prepaid', 'convenio', 'liminar', 'liminar_credit', 'individual', 'updated', 'existing'],
        default: null,
        index: true,
        description: 'Origem do pagamento para rastreabilidade financeira completa'
    },
    
    correlationId: {
        type: String,
        index: true,
        description: 'ID de correlação para rastreamento de transações distribuídas'
    }

}, {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
});

// 🔍 Índice essencial para busca de sessões pendentes por especialidade
sessionSchema.index({ patient: 1, sessionType: 1, paymentStatus: 1, status: 1 });
sessionSchema.index({ patient: 1, paymentStatus: 1, status: 1 });

// 💰 Índices para dashboards financeiros V2 (produção / caixa do profissional)
sessionSchema.index({ doctor: 1, date: -1, status: 1 }, { name: 'financial_doctor_date_status' });
sessionSchema.index({ date: -1, status: 1 }, { name: 'financial_date_status' });

// 🆕 V4: Índice para appointmentId (1 appointment = 1 session)
// NOTA: Índice unique removido temporariamente devido a compatibilidade V1
// que cria Session antes do Appointment. Será reativado após migração completa.
sessionSchema.index(
    { appointmentId: 1 },
    { sparse: true }
);

// 🔒 Pre-validate: garante sessionType preenchido
sessionSchema.pre('validate', function(next) {
    if (!this.sessionType || this.sessionType.trim() === '') {
        throw new Error('Session.sessionType é obrigatório. Não pode ser vazio.');
    }
    next();
});

// Hook pós-save para provisionamento automático
sessionSchema.post('findOneAndUpdate', async function (doc) {
    // 🛡️ CRITICAL FIX: Não roda efeitos colaterais dentro de transação financeira.
    // Se a transação abortar, esses writes NÃO são revertidos — corrompem dados.
    if (this.getOptions().session) {
        console.log('[SessionHook] ⏸️ Provisionamento pulado (dentro de transação)');
        return;
    }
    if (doc && doc.status === 'completed') {
        // Verifica se já não foi provisionado
        const foiProvisionado = doc.wasProvisioned;

        if (!foiProvisionado) {
            try {
                await provisionamentoService.realizarSessao(doc._id, new Date());

                // Marcar como provisionado para não duplicar
                await mongoose.model('Session').updateOne(
                    { _id: doc._id },
                    { $set: { wasProvisioned: true } }
                );
            } catch (err) {
                console.error('Erro ao provisionar sessão:', err);
            }
        }
    }
});

// 🔒 DOMAIN LOCK: Validação extra para garantir sessionType válido ANTES de salvar
sessionSchema.pre('validate', function(next) {
    const validTypes = [
        'fonoaudiologia', 'psicologia', 'terapia ocupacional',
        'fisioterapia', 'pediatria', 'neuroped', 'musicoterapia',
        'psicomotricidade', 'psicopedagogia', 'neuropsicologia'
    ];
    
    // Se sessionType foi setado manualmente e não é válido, rejeita
    if (this.sessionType && !validTypes.includes(this.sessionType)) {
        const error = new Error(
            `[DOMAIN LOCK] sessionType inválido: "${this.sessionType}". ` +
            `Use resolveSessionType() ou normalizeSessionType() do sessionTypeResolver. ` +
            `Valores válidos: ${validTypes.join(', ')}`
        );
        error.code = 'INVALID_SESSION_TYPE';
        return next(error);
    }
    
    next();
});

// 🛡️ FINANCIAL INTEGRITY LOCK: Evita sessions com origens financeiras conflitantes
sessionSchema.pre('validate', function(next) {
    const hasInsuranceGuide = !!this.insuranceGuide;
    const hasPackage = !!this.package;
    const method = (this.paymentMethod || '').toLowerCase();
    const origin = (this.paymentOrigin || '').toLowerCase();
    
    // ❌ Bloqueio 1: insuranceGuide + paymentMethod package_prepaid
    // Se tem guia de convênio, NÃO pode ser marcada como sessão de pacote pré-pago
    if (hasInsuranceGuide && method === 'package_prepaid') {
        const error = new Error(
            `[FINANCIAL INTEGRITY] Session com insuranceGuide não pode ter paymentMethod='package_prepaid'. ` +
            `A guia de convênio indica que o pagador é o convênio, não o pacote. ` +
            `Use paymentMethod='convenio' ou remova o insuranceGuide. ` +
            `Session: ${this._id || '(novo)'}`
        );
        error.code = 'CONFLICTING_FINANCIAL_ORIGIN';
        error.field = 'paymentMethod';
        return next(error);
    }
    
    // ❌ Bloqueio 2: insuranceGuide + paymentOrigin package_prepaid
    if (hasInsuranceGuide && origin === 'package_prepaid') {
        const error = new Error(
            `[FINANCIAL INTEGRITY] Session com insuranceGuide não pode ter paymentOrigin='package_prepaid'. ` +
            `A guia de convênio indica que a origem do pagamento é o convênio, não o pacote. ` +
            `Use paymentOrigin='convenio' ou remova o insuranceGuide. ` +
            `Session: ${this._id || '(novo)'}`
        );
        error.code = 'CONFLICTING_FINANCIAL_ORIGIN';
        error.field = 'paymentOrigin';
        return next(error);
    }
    
    // ⚠️ Alerta (não bloqueia): sessionValue anômalo para convenio
    if (hasInsuranceGuide && this.sessionValue && this.sessionValue > 200) {
        console.warn(
            `[FINANCIAL INTEGRITY WARNING] Session ${this._id || '(novo)'} com insuranceGuide ` +
            `tem sessionValue=${this.sessionValue}, que parece alto para convênio. ` +
            `Verifique se não é um valor de pacote particular.`
        );
    }
    
    next();
});

sessionSchema.post('findOneAndUpdate', async function (doc) {
    // 🛡️ CRITICAL FIX: syncEvent escreve fora da transação — não rodar dentro de mongoSession
    if (this.getOptions().session) return;
    if (doc) await syncEvent(doc, 'session');
});

sessionSchema.post('findOneAndDelete', async function (doc) {
    if (doc) {
        await MedicalEvent.deleteOne({
            originalId: doc._id,
            type: 'session'
        });
    }
});

sessionSchema.post('save', async function (doc) {
    // 🚫 Evita sincronização redundante durante fluxos financeiros
    if (doc._inFinancialTransaction) return;
    await syncEvent(doc, 'session');
});

// 🏥 Hook para consumir guia de convênio quando sessão for concluída
sessionSchema.post('findOneAndUpdate', async function (doc) {
    // 🛡️ CRITICAL FIX: Consumo de guia fora da transação = guia perdida em rollback.
    if (this.getOptions().session) {
        console.log('[SessionHook] ⏸️ Consumo de guia pulado (dentro de transação)');
        return;
    }
    if (!doc) return;

    // Só prossegue se há guia vinculada
    if (!doc.insuranceGuide) return;

    // Idempotência: não consumir se já foi consumido
    if (doc.guideConsumed) return;

    // Só consome se status mudou para 'completed'
    if (doc.status !== 'completed') return;

    try {
        console.log(`🏥 Consumindo guia ${doc.insuranceGuide} para sessão ${doc._id}`);

        const InsuranceGuide = mongoose.model('InsuranceGuide');
        const guide = await InsuranceGuide.findById(doc.insuranceGuide);

        if (!guide) {
            console.warn(`⚠️ Guia ${doc.insuranceGuide} não encontrada`);
            return;
        }

        // Validar guia
        if (guide.status !== 'active') {
            console.warn(`⚠️ Guia ${guide.number} não está ativa (status: ${guide.status})`);
            return;
        }

        if (guide.usedSessions >= guide.totalSessions) {
            console.warn(`⚠️ Guia ${guide.number} já está esgotada`);
            return;
        }

        // Consumir sessão
        guide.usedSessions += 1;

        // Se esgotou, marcar como exhausted
        if (guide.usedSessions >= guide.totalSessions) {
            guide.status = 'exhausted';
        }

        await guide.save();

        // Marcar sessão como consumida (idempotência)
        await mongoose.model('Session').updateOne(
            { _id: doc._id },
            { $set: { guideConsumed: true } }
        );

        console.log(`✅ Guia consumida: ${guide.usedSessions}/${guide.totalSessions} sessões`);

    } catch (error) {
        console.error(`❌ Erro ao consumir guia para sessão ${doc._id}:`, error);
        // NÃO lança erro para não quebrar o fluxo principal
    }
});

// 🚨 Hook para detectar reversão de status (completed → outro)
sessionSchema.post('findOneAndUpdate', async function (doc) {
    if (!doc) return;

    // Só monitora se já foi consumida
    if (!doc.guideConsumed) return;
    if (!doc.insuranceGuide) return;

    // Se voltou de completed para outro status
    if (doc.status !== 'completed') {
        console.warn(`⚠️ ATENÇÃO: Sessão ${doc._id} mudou de 'completed' para '${doc.status}' mas guia já foi consumida!`);
        console.warn(`⚠️ Guia ${doc.insuranceGuide} NÃO será revertida automaticamente.`);
        // NÃO reverte automaticamente conforme especificação
    }
});

// 🏗️ Hook para gerenciar statusHistory e sessionConsumed
sessionSchema.pre('save', function(next) {
    if (this.isModified('status')) {
        // Adicionar ao histórico
        if (!this.statusHistory) this.statusHistory = [];
        this.statusHistory.push({
            status: this.status,
            at: new Date()
        });

        // Atualizar sessionConsumed baseado no status
        if (this.status === 'completed') {
            this.sessionConsumed = true;

            // Marcar revenue recognized
            if (!this.revenueRecognizedAt) {
                this.revenueRecognizedAt = new Date();
            }
        } else if (this.status === 'missed') {
            // Falta consome sessão mas não gera comissão
            this.sessionConsumed = true;
        } else if (this.status === 'canceled') {
            // Cancelamento não consome
            this.sessionConsumed = false;
        }
    }
    next();
});

sessionSchema.pre('findOneAndUpdate', async function(next) {
    const update = this.getUpdate();
    const doc = await this.model.findOne(this.getQuery());

    if (update.$set && update.$set.status && doc && doc.status !== update.$set.status) {
        const newStatus = update.$set.status;
        const oldStatus = doc.status;

        // Adicionar ao histórico
        if (!update.$push) update.$push = {};
        if (!update.$push.statusHistory) update.$push.statusHistory = {};
        update.$push.statusHistory = {
            status: newStatus,
            at: new Date()
        };

        // Detectar reversão (completed → canceled)
        if (oldStatus === 'completed' && newStatus === 'canceled') {
            console.warn(`🔄 REVERSÃO: Sessão ${doc._id} de completed para canceled`);
            update.$set.sessionConsumed = false;
            // Aqui poderia gerar uma entrada de reversão no ledger
        }

        // Novo completed
        if (newStatus === 'completed') {
            update.$set.sessionConsumed = true;

            if (!doc.revenueRecognizedAt) {
                update.$set.revenueRecognizedAt = new Date();
            }
        }
    }
    next();
});

sessionSchema.add({
    wasProvisioned: { type: Boolean, default: false },
    dataRealizacao: { type: Date }
});

// 🧹 CASCADE DELETE: Quando deletar session, limpar referências e marcar débitos
sessionSchema.post('findOneAndDelete', async function (doc) {
    if (doc) {
        // 1. Remover MedicalEvent
        await MedicalEvent.deleteOne({
            originalId: doc._id,
            type: 'session'
        });
        
        // 2. Marcar débitos no PatientBalance como cancelados
        if (doc.patient && doc.appointmentId) {
            try {
                const { default: PatientBalance } = await import('./PatientBalance.js');
                const balance = await PatientBalance.findOne({ patient: doc.patient });
                if (balance) {
                    let changed = false;
                    for (const t of balance.transactions) {
                        if (t.sessionId?.toString() === doc._id.toString() ||
                            t.appointmentId?.toString() === doc.appointmentId.toString()) {
                            if (t.type === 'debit' && !t.isPaid) {
                                t.isDeleted = true;
                                t.deletedAt = new Date();
                                t.deleteReason = 'cascade-delete: session deleted';
                                changed = true;
                            }
                        }
                    }
                    if (changed) {
                        await balance.save();
                        console.log(`🧹 Cascade delete: débitos da session ${doc._id} marcados como cancelados`);
                    }
                }
            } catch (error) {
                console.error('⚠️ Erro ao cancelar débitos no cascade delete:', error.message);
            }
        }
    }
});

// 🧹 Pre-deleteOne e deleteMany com cascade
sessionSchema.pre('deleteOne', { document: true, query: false }, async function() {
    const sessionId = this._id;
    const patientId = this.patient;
    const appointmentId = this.appointmentId;
    
    try {
        // Marcar débitos como cancelados
        if (patientId && appointmentId) {
            const { default: PatientBalance } = await import('./PatientBalance.js');
            const balance = await PatientBalance.findOne({ patient: patientId });
            if (balance) {
                let changed = false;
                for (const t of balance.transactions) {
                    if (t.sessionId?.toString() === sessionId.toString() ||
                        t.appointmentId?.toString() === appointmentId.toString()) {
                        if (t.type === 'debit' && !t.isPaid) {
                            t.isDeleted = true;
                            t.deletedAt = new Date();
                            t.deleteReason = 'cascade-delete: session deleted';
                            changed = true;
                        }
                    }
                }
                if (changed) await balance.save();
            }
        }
    } catch (error) {
        console.error('⚠️ Erro no cascade deleteOne de session:', error.message);
    }
});

// 🧹 MÉTODO: Soft delete em cascata (marca session e cancela débitos)
sessionSchema.methods.softDeleteCascade = async function(reason = 'manual', deletedBy = null) {
    const session = await mongoose.startSession();
    session.startTransaction();
    
    try {
        const sessionId = this._id;
        const patientId = this.patient;
        const appointmentId = this.appointmentId;
        
        // 1. Marcar débitos como cancelados
        if (patientId && appointmentId) {
            const { default: PatientBalance } = await import('./PatientBalance.js');
            const balance = await PatientBalance.findOne({ patient: patientId });
            if (balance) {
                let changed = false;
                for (const t of balance.transactions) {
                    if (t.sessionId?.toString() === sessionId.toString() ||
                        t.appointmentId?.toString() === appointmentId.toString()) {
                        if (t.type === 'debit' && !t.isPaid) {
                            t.isDeleted = true;
                            t.deletedAt = new Date();
                            t.deleteReason = `cascade-delete: ${reason}`;
                            t.deletedBy = deletedBy;
                            changed = true;
                        }
                    }
                }
                if (changed) await balance.save({ session });
            }
        }
        
        // 2. Soft delete na session
        this.isDeleted = true;
        this.deletedAt = new Date();
        this.deleteReason = reason;
        this.deletedBy = deletedBy;
        await this.save({ session });
        
        await session.commitTransaction();
        console.log(`🧹 Soft delete cascade: session ${sessionId} + débitos cancelados`);
        
        return { success: true, sessionId };
    } catch (error) {
        await session.abortTransaction();
        console.error('💥 Erro no soft delete cascade de session:', error.message);
        throw error;
    } finally {
        session.endSession();
    }
};

// 💰 Financial Sanitizer — bloqueia writes V1 na origem
sessionSchema.plugin(financialSanitizer, { entity: 'Session' });

const Session = mongoose.model('Session', sessionSchema);

export default Session;