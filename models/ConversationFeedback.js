// models/ConversationFeedback.js - NOVO MODEL
const conversationFeedbackSchema = new mongoose.Schema({
    lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', required: true },
    messageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', required: true },

    // Mensagem que a Amanda enviou
    amandaResponse: String,

    // Contexto da conversa
    userMessage: String,
    detectedIntent: String,
    detectedTherapies: [String],

    // ✅ FEEDBACK
    wasCorrect: { type: Boolean, default: null }, // null = não avaliado ainda
    humanCorrection: String, // Se humano assumiu, qual foi a resposta?
    feedbackType: {
        type: String,
        enum: ['correct', 'partially_correct', 'wrong', 'needs_human'],
        default: null
    },

    // Métricas
    leadConverted: Boolean, // Lead agendou/virou paciente depois?
    responseTime: Number, // Tempo até responder (ms)

    createdAt: { type: Date, default: Date.now }
});

export  default ConversationFeedback;