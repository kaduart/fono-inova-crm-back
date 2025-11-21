import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import Lead from '../models/Leads.js';
import Message from '../models/Message.js';

await mongoose.connect(process.env.MONGO_URI);

const leads = await Lead.find({
  $or: [
    { contact: { $exists: false } },
    { 'contact.phone': { $exists: false } }
  ]
});

for (const lead of leads) {
  console.log('⚙️ Ajustando lead', lead._id, lead.name);

  // 1) tenta usar lead.phone se tiver
  let phone = lead.phone;

  // 2) se não tiver, busca na última mensagem inbound
  if (!phone) {
    const msg = await Message.findOne({
      lead: lead._id,
      direction: 'inbound'
    }).sort({ timestamp: -1 });

    if (msg?.from) {
      phone = msg.from;
    }
  }

  if (!phone) {
    console.log('❌ Não achei telefone pra esse lead, pulando...');
    continue;
  }

  // garante subdocumento contact
  if (!lead.contact) {
    lead.contact = {};
  }

  lead.contact.phone = phone;
  lead.phone = phone; // opcional: manter espelho

  await lead.save();
  console.log('✅ Lead ajustado com phone:', phone);
}

await mongoose.disconnect();
console.log('🏁 Fim do script');
