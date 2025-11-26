import mongoose from "mongoose";
import Lead from "../../models/Leads.js";
import dotenv from 'dotenv';
dotenv.config();

await mongoose.connect(process.env.MONGO_URI);

const phone = "5561981694922"; 

const lead = await Lead.findOneAndUpdate(
  { "contact.phone": phone },
  {
    name: "Teste Amanda Dev",
    origin: "teste_interno",
    contact: { phone },
  },
  { upsert: true, new: true }
);

console.log("Lead de teste:", lead._id, lead.contact.phone);
process.exit(0);