// models/Session.js
import mongoose from 'mongoose';
import { syncEvent } from '../services/syncService.js';
import provisionamentoService from '../services/provisionamentoService.js';
import MedicalEvent from './MedicalEvent.js';

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
                'psicopedagogia'
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
    confirmedAbsence: { type: Boolean, default: null },
    notes: { type: String },
    paymentStatus: {
        type: String,
        enum: ['paid', 'partial', 'pending', 'pending_receipt', 'recognized', 'package_paid', 'pending_balance'],
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
    
    // ⭐ CAMPOS PARA ARQUITETURA FINANCEIRA ROBUSTA
    
    sessionConsumed: {
        type: Boolean,
        default: false,
        description: 'Define se a sessão consome do pacote/saldo (true para completed/missed, false para canceled)'
    },
    
    commissionRate: {
        type: Number,
        default: null,
        description: 'Percentual de comissão do profissional (ex: 0.5 para 50%)'
    },
    
    commissionValue: {
        type: Number,
        default: null,
        description: 'Valor calculado da comissão (sessionValue * commissionRate)'
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
        enum: ['auto_per_session', 'manual_balance', 'package_prepaid', 'convenio', 'liminar', 'individual'],
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

// 🆕 V4: Índice único para appointmentId (1 appointment = 1 session)
sessionSchema.index(
    { appointmentId: 1 },
    { unique: true, sparse: true }
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

sessionSchema.post('findOneAndUpdate', async function (doc) {
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

// 🏗️ Hook para gerenciar statusHistory, commission e sessionConsumed
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
            
            // Calcular comissão se temos rate e value
            if (this.commissionRate && this.sessionValue && !this.commissionValue) {
                this.commissionValue = this.sessionValue * this.commissionRate;
            }
            
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
            
            // Zerar comissão se estava completed antes
            if (this.commissionValue) {
                this.commissionValue = 0;
            }
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
            update.$set.commissionValue = 0;
            // Aqui poderia gerar uma entrada de reversão no ledger
        }
        
        // Novo completed
        if (newStatus === 'completed') {
            update.$set.sessionConsumed = true;
            
            // Calcular comissão
            const sessionValue = update.$set.sessionValue || doc.sessionValue;
            const commissionRate = update.$set.commissionRate || doc.commissionRate;
            if (commissionRate && sessionValue) {
                update.$set.commissionValue = sessionValue * commissionRate;
            }
            
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

const Session = mongoose.model('Session', sessionSchema);

export default Session;