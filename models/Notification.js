import mongoose from 'mongoose';

/**
 * Notification - Sistema de notificações persistentes
 * 
 * Fluxo:
 * 1. PreAgendamento é criado
 * 2. Se fora do horário comercial → cria Notification
 * 3. Usuário loga → vê badge no header com contador
 * 4. Clica na notificação → marca como lida → remove do badge
 */

const notificationSchema = new mongoose.Schema({
  // Tipo da notificação
  type: {
    type: String,
    enum: ['preagendamento', 'agendamento_confirmado', 'cancelamento', 'sistema'],
    default: 'preagendamento'
  },

  // Referência ao documento relacionado
  refId: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: 'refModel',
    required: true
  },
  refModel: {
    type: String,
    enum: ['Appointment'],
    default: 'Appointment'
  },

  // Dados enriquecidos para exibição rápida (evita populate)
  data: {
    patientName: { type: String, required: true },
    specialty: String,
    doctorName: String,
    date: String, // YYYY-MM-DD
    time: String, // HH:MM
    phone: String,
    source: String // amandaAI, agenda_externa, etc
  },

  // Status da notificação
  status: {
    type: String,
    enum: ['unread', 'read', 'dismissed'],
    default: 'unread'
  },

  // Prioridade (para ordenação)
  priority: {
    type: String,
    enum: ['low', 'normal', 'high', 'urgent'],
    default: 'normal'
  },

  // Usuários destinatários (pode ser broadcast ou específico)
  recipients: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    status: { type: String, enum: ['unread', 'read', 'dismissed'], default: 'unread' },
    readAt: Date
  }],

  // Se é notificação broadcast (todos os usuários do sistema)
  isBroadcast: { type: Boolean, default: true },

  // Horário em que foi criada
  createdAt: { type: Date, default: Date.now },

  // Expiração automática (7 dias)
  expiresAt: { 
    type: Date, 
    default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  }
}, {
  timestamps: true
});

// Índices para performance
notificationSchema.index({ status: 1, createdAt: -1 });
notificationSchema.index({ 'recipients.userId': 1, 'recipients.status': 1 });
notificationSchema.index({ isBroadcast: 1, status: 1 });
notificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL

// Método estático: Criar notificação de pré-agendamento
notificationSchema.statics.createFromPreAgendamento = async function(preAgendamento) {
  const data = {
    patientName: preAgendamento.patientInfo?.fullName || 'Paciente',
    specialty: preAgendamento.specialty,
    doctorName: preAgendamento.professionalName,
    date: preAgendamento.preferredDate,
    time: preAgendamento.preferredTime,
    phone: preAgendamento.patientInfo?.phone,
    source: preAgendamento.source
  };

  // Determina prioridade baseada na urgência
  let priority = 'normal';
  if (preAgendamento.urgency === 'critica') priority = 'urgent';
  else if (preAgendamento.urgency === 'alta') priority = 'high';

  return this.create({
    type: 'preagendamento',
    refId: preAgendamento._id,
    refModel: 'PreAgendamento',
    data,
    priority,
    isBroadcast: true // Todas as secretárias veem
  });
};

// Método estático: Buscar não lidas para um usuário
notificationSchema.statics.getUnreadForUser = async function(userId, options = {}) {
  const { limit = 20, type = null } = options;
  
  const query = {
    $or: [
      { isBroadcast: true, status: 'unread' },
      { 'recipients.userId': userId, 'recipients.status': 'unread' }
    ]
  };

  if (type) query.type = type;

  return this.find(query)
    .sort({ priority: -1, createdAt: -1 }) // Urgente primeiro, depois mais recente
    .limit(limit)
    .lean();
};

// Método estático: Contar não lidas
notificationSchema.statics.countUnreadForUser = async function(userId) {
  return this.countDocuments({
    $or: [
      { isBroadcast: true, status: 'unread' },
      { 'recipients.userId': userId, 'recipients.status': 'unread' }
    ]
  });
};

// Método de instância: Marcar como lida por usuário
notificationSchema.methods.markAsRead = async function(userId) {
  // Se é broadcast, adiciona o usuário como recipient lido
  if (this.isBroadcast) {
    const existingRecipient = this.recipients.find(r => 
      r.userId?.toString() === userId.toString()
    );
    
    if (!existingRecipient) {
      this.recipients.push({
        userId,
        status: 'read',
        readAt: new Date()
      });
    } else if (existingRecipient.status !== 'read') {
      existingRecipient.status = 'read';
      existingRecipient.readAt = new Date();
    }
  } else {
    // Se é notificação específica, marca geral como lida
    this.status = 'read';
  }
  
  return this.save();
};

// Método de instância: Marcar como lida por todos (admin)
notificationSchema.methods.markAsReadByAll = async function() {
  this.status = 'read';
  return this.save();
};

const Notification = mongoose.model('Notification', notificationSchema);

export default Notification;
