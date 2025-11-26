// scripts/create-test-followup.js
import mongoose from "mongoose";
import Followup from "../../models/Followup.js";
import dotenv from 'dotenv';
dotenv.config();

await mongoose.connect(process.env.MONGO_URI);

// coloque aqui o _id do lead de teste
const leadId = "6926f5dbefb2232de9197046";

const f = await Followup.create({
  lead: leadId,
  stage: "follow_up",
  scheduledAt: new Date(),   // já elegível pro cron
  status: "scheduled",
  aiOptimized: true,
  origin: "teste_interno",
  message: "",               // deixa vazio pra Amanda 2.0 gerar
  note: "Follow-up de teste dev"
});

console.log("Followup criado:", f._id);
process.exit(0);
