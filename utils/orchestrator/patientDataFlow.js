// utils/orchestrator/patientDataFlow.js

import Followup from "../../models/Followup.js";
import Leads from "../../models/Leads.js";
import { autoBookAppointment, formatDatePtBr } from "../../services/amandaBookingService.js";
import { default as ensureSingleHeart, default as safeLeadUpdate } from "../helpers.js";
import { extractBirth, extractName } from "../patientDataExtractor.js";

/**
 * Processa fluxo de coleta de dados do paciente (nome → nascimento → booking)
 * @returns {string|null} Resposta se processou, null se não é esse fluxo
 */
export async function handlePatientDataFlow({ text, lead }) {
    if (!lead?.pendingPatientInfoForScheduling || !lead?._id) {
        return null; // Não é esse fluxo
    }

    console.log("📝 [PATIENT-DATA] Processando coleta de dados");

    const step = lead.pendingPatientInfoStep || "name";
    const chosenSlot = lead.pendingChosenSlot;

    // STEP: NAME
    if (step === "name") {
        const name = extractName(text);
        if (!name) {
            return ensureSingleHeart("Pra eu confirmar certinho: qual o **nome completo** do paciente?");
        }

        await safeLeadUpdate(lead._id, {
            $set: { "patientInfo.fullName": name, pendingPatientInfoStep: "birth" }
        });

        return ensureSingleHeart("Obrigada! Agora me manda a **data de nascimento** (dd/mm/aaaa)");
    }

    // STEP: BIRTH
    if (step === "birth") {
        const birthDate = extractBirth(text);
        if (!birthDate) {
            return ensureSingleHeart("Me manda a **data de nascimento** no formato **dd/mm/aaaa**");
        }

        const updated = await Leads.findById(lead._id).lean().catch(() => null);
        const fullName = updated?.patientInfo?.fullName;
        const phone = updated?.contact?.phone;

        if (!fullName || !chosenSlot) {
            return ensureSingleHeart("Perfeito! Só mais um detalhe: confirma pra mim o **nome completo** do paciente?");
        }

        await safeLeadUpdate(lead._id, {
            $set: { "patientInfo.birthDate": birthDate }
        });

        // Tenta agendar
        const bookingResult = await autoBookAppointment({
            lead: updated,
            chosenSlot,
            patientInfo: { fullName, birthDate, phone }
        });

        if (bookingResult.success) {
            await safeLeadUpdate(lead._id, {
                $set: { status: "agendado", stage: "paciente", patientId: bookingResult.patientId },
                $unset: {
                    pendingSchedulingSlots: "",
                    pendingChosenSlot: "",
                    pendingPatientInfoForScheduling: "",
                    pendingPatientInfoStep: "",
                    autoBookingContext: "",
                },
            });

            await Followup.updateMany(
                { lead: lead._id, status: "scheduled" },
                { $set: { status: "canceled", canceledReason: "agendamento_confirmado_amanda" } }
            );

            const humanDate = formatDatePtBr(chosenSlot.date);
            const humanTime = String(chosenSlot.time || "").slice(0, 5);

            return ensureSingleHeart(
                `Que maravilha! 🎉 Tudo certo!\n\n` +
                `📅 **${humanDate}** às **${humanTime}**\n` +
                `👩‍⚕️ Com **${chosenSlot.doctorName}**\n\n` +
                `Vocês vão adorar conhecer a clínica! Qualquer dúvida, é só me chamar 💚`
            );
        }

        if (bookingResult.code === "TIME_CONFLICT") {
            await safeLeadUpdate(lead._id, {
                $set: { pendingChosenSlot: null, pendingPatientInfoForScheduling: false }
            });
            return ensureSingleHeart("Esse horário acabou de ser preenchido 😕 A equipe vai te enviar novas opções em instantes");
        }

        return ensureSingleHeart("Tive um probleminha ao confirmar. A equipe vai te responder por aqui em instantes");
    }

    return null;
}