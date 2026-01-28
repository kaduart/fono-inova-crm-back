// scripts/test-orchestrator.js

import dotenv from "dotenv";
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../.env') });

const mongoose = (await import('mongoose')).default;
const Leads = (await import('../models/Leads.js')).default;
const { WhatsAppOrchestrator } = await import('../orchestrators/WhatsAppOrchestrator.js');

await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
console.log("✅ Conectado ao MongoDB");

const leadId = '697a4896e0a21156a0c0cf81';
const lead = await Leads.findById(leadId);

// ✅ Instancia a classe
const orchestrator = new WhatsAppOrchestrator();

// ✅ Usa o método certo: process({ lead, message, services })
const result = await orchestrator.process({
    lead,
    message: { text: 'ele não presta atenção nas aulas e tem ansiedade', type: 'text' },
    services: {}
});

console.log('RESULTADO:', result);

const updated = await Leads.findById(leadId);
console.log('LEAD APÓS:', {
    primaryComplaint: updated.primaryComplaint,
    qualificationData: updated.qualificationData
});

process.exit(0);