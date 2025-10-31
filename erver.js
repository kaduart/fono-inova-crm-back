[1mdiff --git a/models/Leads.js b/models/Leads.js[m
[1mindex 7187b148..7f1ff10d 100644[m
[1m--- a/models/Leads.js[m
[1m+++ b/models/Leads.js[m
[36m@@ -1,3 +1,4 @@[m
[32m+[m[32m// models/Leads.js - VERSÃO ATUALIZADA[m[41m[m
 import mongoose from 'mongoose';[m
 [m
 const interactionSchema = new mongoose.Schema({[m
[36m@@ -15,20 +16,71 @@[m [mconst leadSchema = new mongoose.Schema({[m
     email: String,[m
     phone: { type: String, index: true }[m
   },[m
[31m-  origin: { type: String, enum: ['WhatsApp', 'Site', 'Indicação', 'Outro'], default: 'Outro' },[m
[31m-  status: { type: String, enum: ['novo', 'atendimento', 'convertido', 'perdido'], default: 'novo', index: true },[m
[32m+[m[32m  origin: {[m[41m[m
[32m+[m[32m    type: String,[m[41m[m
[32m+[m[32m    enum: ['WhatsApp', 'Site', 'Indicação', 'Outro', 'Tráfego pago', 'Google', 'Instagram', 'Meta Ads'],[m[41m[m
[32m+[m[32m    default: 'Outro'[m[41m[m
[32m+[m[32m  },[m[41m[m
[32m+[m[41m[m
[32m+[m[32m  // ✅ CAMPOS NOVOS DA PLANILHA (sem quebrar estrutura existente)[m[41m[m
[32m+[m[32m  appointment: {[m[41m[m
[32m+[m[32m    seekingFor: {[m[41m[m
[32m+[m[32m      type: String,[m[41m[m
[32m+[m[32m      enum: ['Adulto +18 anos', 'Infantil', 'Graduação'],[m[41m[m
[32m+[m[32m      default: 'Adulto +18 anos'[m[41m[m
[32m+[m[32m    },[m[41m[m
[32m+[m[32m    modality: {[m[41m[m
[32m+[m[32m      type: String,[m[41m[m
[32m+[m[32m      enum: ['Online', 'Presencial'],[m[41m[m
[32m+[m[32m      default: 'Online'[m[41m[m
[32m+[m[32m    },[m[41m[m
[32m+[m[32m    healthPlan: {[m[41m[m
[32m+[m[32m      type: String,[m[41m[m
[32m+[m[32m      enum: ['Graduação', 'Mensalidade', 'Dependente'],[m[41m[m
[32m+[m[32m      default: 'Mensalidade'[m[41m[m
[32m+[m[32m    }[m[41m[m
[32m+[m[32m  },[m[41m[m
[32m+[m[41m[m
[32m+[m[32m  // ✅ STATUS EXPANDIDO (mantendo compatibilidade)[m[41m[m
[32m+[m[32m  status: {[m[41m[m
[32m+[m[32m    type: String,[m[41m[m
[32m+[m[32m    enum: [[m[41m[m
[32m+[m[32m      'novo',[m[41m[m
[32m+[m[32m      'atendimento',[m[41m[m
[32m+[m[32m      'convertido',[m[41m[m
[32m+[m[32m      'perdido',[m[41m[m
[32m+[m[32m      // Novos status da planilha[m[41m[m
[32m+[m[32m      'em_andamento',[m[41m[m
[32m+[m[32m      'lista_espera',[m[41m[m
[32m+[m[32m      'pendencia_documentacao',[m[41m[m
[32m+[m[32m      'sem_cobertura',[m[41m[m
[32m+[m[32m      'virou_paciente',[m[41m[m
[32m+[m[32m      'lead_quente',[m[41m[m
[32m+[m[32m      'lead_frio'[m[41m[m
[32m+[m[32m    ],[m[41m[m
[32m+[m[32m    default: 'novo',[m[41m[m
[32m+[m[32m    index: true[m[41m[m
[32m+[m[32m  },[m[41m[m
[32m+[m[41m[m
   owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },[m
   interactions: [interactionSchema],[m
   lastInteractionAt: { type: Date, default: Date.now },[m
[31m-  notes: String[m
[32m+[m[32m  notes: String,[m[41m[m
[32m+[m[41m[m
[32m+[m[32m  // ✅ NOVOS CAMPOS PARA MÉTRICAS[m[41m[m
[32m+[m[32m  circuit: { type: String, default: 'Circuito Padrão' },[m[41m[m
[32m+[m[32m  scheduledDate: { type: Date },[m[41m[m
[32m+[m[32m  convertedToPatient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient' },[m[41m[m
[32m+[m[32m  conversionScore: { type: Number, default: 0 },[m[41m[m
[32m+[m[41m[m
 }, { timestamps: true });[m
 [m
 // Middleware para atualizar última interação[m
[31m-leadSchema.pre('save', function(next) {[m
[32m+[m[32mleadSchema.pre('save', function (next) {[m[41m[m
   if (this.interactions && this.interactions.length > 0) {[m
     this.lastInteractionAt = this.interactions[this.interactions.length - 1].date;[m
   }[m
   next();[m
 });[m
 [m
[31m-export default mongoose.model('Leads', leadSchema);[m
[32m+[m[32mexport default mongoose.model('Leads', leadSchema);[m
\ No newline at end of file[m
[1mdiff --git a/scripts/db-scripts.js b/scripts/db-scripts.js[m
[1mindex a8290130..9915bd67 100644[m
[1m--- a/scripts/db-scripts.js[m
[1m+++ b/scripts/db-scripts.js[m
[36m@@ -63,8 +63,8 @@[m [mdb.appointments.find({[m
 // consultar pagamentos do dia[m
 db.payments.find({[m
   createdAt: {[m
[31m-    $gte: ISODate("2025-10-24T00:00:00.000Z"),[m
[31m-    $lt: ISODate("2025-10-25T00:00:00.000Z")[m
[32m+[m[32m    $gte: ISODate("2025-10-29T00:00:00.000Z"),[m[41m[m
[32m+[m[32m    $lt: ISODate("2025-10-30T00:00:00.000Z")[m[41m[m
   }[m
 })[m
 /// atualizar pagamaneto por id[m
[36m@@ -93,7 +93,7 @@[m [mdb.appointments.find({[m
 [m
 ///ouuuuu // Buscar agendamentos de hoje - 27/10/2025[m
 db.appointments.find({[m
[31m-  date: "2025-10-27"[m
[32m+[m[32m  date: "2025-10-29"[m[41m[m
 }).sort({ time: 1 })[m
 [m
 //agendamentos do dia [m
[1mdiff --git a/server.js b/server.js[m
[1mindex b6fc84f3..1c89d90c 100644[m
[1m--- a/server.js[m
[1m+++ b/server.js[m
[36m@@ -56,6 +56,7 @@[m [mimport specialtyRouter from "./routes/specialty.js";[m
 import UserRoutes from "./routes/user.js";[m
 import whatsappRoutes from "./routes/whatsapp.js";[m
 import reportsRoutes from "./routes/reports/index.js";[m
[32m+[m[32mimport leadRoutes from './routes/leads.js';[m[41m[m
 [m
 console.log("🧠 PIX ROUTES carregado com sucesso ✅");[m
 [m
[36m@@ -142,6 +143,7 @@[m [mapp.use("/api/google-ads", googleAdsRoutes);[m
 app.use("/api/google-ads/auth", googleAdsAuthRoutes);[m
 app.use("/api/amanda", amandaRoutes);[m
 app.use('/api/reports', reportsRoutes);[m
[32m+[m[32mapp.use('/api/leads', leadRoutes);[m[41m[m
 [m
 // ✅ PIX webhook agora ativo, sem fallback duplicado[m
 app.use("/api/pix", pixRoutes);[m
