// scripts/corrections/migrateAppointmentStatuses.js
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";

// ---------------------------
// 🧩 Resolver caminhos ESM
// ---------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import dinâmico do model (corrige erro de caminho)
const AppointmentModule = await import(path.join(__dirname, "../../models/Appointment.js"));
const Appointment = AppointmentModule.default;

// ---------------------------
// 🌱 Configuração do ambiente
// ---------------------------
dotenv.config();
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
    console.error("❌ ERRO: MONGO_URI não encontrado no .env");
    process.exit(1);
}

// ---------------------------
// 🔁 Mapeamentos de status
// ---------------------------
const mapOperational = {
    agendado: "scheduled",
    confirmado: "confirmed",
    cancelado: "canceled",
    pago: "paid",
    faltou: "missed",
};

const mapClinical = {
    pendente: "pending",
    em_andamento: "in_progress",
    concluído: "completed",
    faltou: "missed",
};

// ---------------------------
// 🚀 Execução principal
// ---------------------------
async function migrateStatuses() {
    try {
        console.log("🔗 Conectando ao MongoDB...");
        await mongoose.connect(MONGO_URI);
        console.log("✅ Conectado com sucesso!");

        const appointments = await Appointment.find({});
        console.log(`📦 ${appointments.length} agendamentos encontrados.`);

        let updatedCount = 0;

        for (const appt of appointments) {
            let updated = false;

            if (mapOperational[appt.operationalStatus]) {
                appt.operationalStatus = mapOperational[appt.operationalStatus];
                updated = true;
            }

            if (mapClinical[appt.clinicalStatus]) {
                appt.clinicalStatus = mapClinical[appt.clinicalStatus];
                updated = true;
            }

            if (updated) {
                await appt.save({ validateBeforeSave: false });
                updatedCount++;
            }

        }

        console.log(`✅ ${updatedCount} documentos atualizados com sucesso.`);
        console.log("🏁 Migração finalizada!");
        process.exit(0);
    } catch (error) {
        console.error("❌ Erro na migração:", error);
        process.exit(1);
    }
}

migrateStatuses();
