import Lead from "../models/Leads.js";
import ensureSingleHeart from "../utils/helpers.js";
import smartFollowup from "./intelligence/smartFollowup.js";

/**
 * Engine central da jornada do paciente
 * NÃO substitui smartFollowup
 * Apenas decide QUANDO disparar
 */

export async function runJourneyFollowups(leadId, context = {}) {
    try {
        const lead = await Lead.findById(leadId);
        if (!lead) return;

        const stage = lead.patientJourneyStage;
        if (!stage) return;

        console.log("🚀 [JOURNEY] Stage:", stage);

        switch (stage) {
            case "onboarding":
                await handleOnboarding(lead, context);
                break;

            case "ativo":
                await handleActivePatient(lead, context);
                break;

            case "renovacao":
                await handleRenewal(lead, context);
                break;

            case "alta":
                await handleDischarge(lead, context);
                break;

            default:
                console.log("⚠️ [JOURNEY] Stage desconhecido:", stage);
        }
    } catch (err) {
        console.error("❌ [JOURNEY] erro:", err.message);
    }
}

/* ======================================================
   ONBOARDING – anti no-show
====================================================== */

async function handleOnboarding(lead, context) {
    const { appointment } = context;
    if (!appointment) return;

    const alreadySent = lead?.journeyFlags?.onboardingReminder;

    if (!alreadySent) {
        await smartFollowup.sendMessage(lead.phone,
            ensureSingleHeart(
                `Oi ${lead.name || ""} 💚
Passando pra lembrar da avaliação amanhã às ${appointment.time}.
Vai ser tranquila e acolhedora.
Qualquer dúvida estou por aqui.`
            )
        );

        await Lead.findByIdAndUpdate(lead._id, {
            $set: { "journeyFlags.onboardingReminder": true }
        });
    }
}

/* ======================================================
   PACIENTE ATIVO – sessões 1,4,6
====================================================== */

async function handleActivePatient(lead, context) {
    const { sessionNumber, patientName } = context;
    if (!sessionNumber) return;

    const key = `session_${sessionNumber}`;
    if (lead?.journeyFlags?.[key]) return;

    let msg = null;

    if (sessionNumber === 1) {
        msg = `Oi ${lead.name || ""} 💚
Como vocês se sentiram na primeira sessão do ${patientName}?
Nosso objetivo é sempre acolher e orientar da melhor forma.`;
    }

    if (sessionNumber === 4) {
        msg = `Oi ${lead.name || ""} 💚
Como vocês estão percebendo a evolução do ${patientName}?
Já notaram alguma mudança no dia a dia?`;
    }

    if (sessionNumber === 6) {
        msg = `Oi ${lead.name || ""} 💚
Que bom caminhar com vocês nesse processo.
A constância faz toda diferença na evolução.`;
    }

    if (!msg) return;

    await smartFollowup.sendMessage(
        lead.phone,
        ensureSingleHeart(msg)
    );

    await Lead.findByIdAndUpdate(lead._id, {
        $set: { [`journeyFlags.${key}`]: true }
    });
}

/* ======================================================
   RENOVAÇÃO
====================================================== */

async function handleRenewal(lead, context) {
    if (lead?.journeyFlags?.renewalAsked) return;

    const { patientName } = context;

    await smartFollowup.sendMessage(
        lead.phone,
        ensureSingleHeart(
            `Oi ${lead.name || ""} 💚
Percebi que o pacote do ${patientName} está chegando ao final.
Pela evolução até aqui, o ideal é manter a continuidade.
Posso te explicar as opções?`
        )
    );

    await Lead.findByIdAndUpdate(lead._id, {
        $set: { "journeyFlags.renewalAsked": true }
    });
}

/* ======================================================
   ALTA
====================================================== */

async function handleDischarge(lead) {
    if (lead?.journeyFlags?.dischargeSent) return;

    await smartFollowup.sendMessage(
        lead.phone,
        ensureSingleHeart(
            `Foi um prazer caminhar com vocês 💚
Qualquer coisa que precisarem, a Fono Inova estará sempre aqui.`
        )
    );

    await Lead.findByIdAndUpdate(lead._id, {
        $set: { "journeyFlags.dischargeSent": true }
    });
}
