// ============================================================================
// 🤖 AMANDA AUTO-BOOKING - VERSÃO CONSOLIDADA
// ============================================================================
// Arquivo: services/amandaBookingService.js

import axios from "axios";
import {
    addDays,
    format,
    isAfter,
    isWithinInterval,
    parseISO,
    startOfDay,
} from "date-fns";
import Doctor from "../models/Doctor.js";
import { RECESSO, isInRecesso, getFirstAvailableDate } from '../config/clinic.js';

// 🔗 Base interna: primeiro INTERNAL_BASE_URL, depois BACKEND_URL_PRD, depois localhost
const API_BASE =
    process.env.INTERNAL_BASE_URL ||
    process.env.BACKEND_URL_PRD

if (!API_BASE) {
    throw new Error(
        "[AMANDA-BOOKING] API_BASE não definido. Defina INTERNAL_BASE_URL ou BACKEND_URL_PRD."
    );
}
const ADMIN_TOKEN = process.env.ADMIN_API_TOKEN;

// ============================================================================
// 🌐 Cliente HTTP interno com token da Amanda
// ============================================================================
const api = axios.create({
    baseURL: API_BASE,
    timeout: 8000,
});

api.interceptors.request.use((config) => {
    config.headers = config.headers || {};

    if (ADMIN_TOKEN) {
        config.headers["Authorization"] = `Bearer ${ADMIN_TOKEN}`;
    } else {
        console.warn("[AMANDA-BOOKING] ADMIN_API_TOKEN não definido!");
    }

    if (!config.headers["Content-Type"] && config.method !== "get") {
        config.headers["Content-Type"] = "application/json";
    }

    return config;
});

// Estatísticas simples (só pra log/monitorar)
const bookingStats = {
    totalAttempts: 0,
    successful: 0,
    conflicts: 0,
    errors: 0,
};

export function isDateBlocked(dateStr) {
    try {
        return isInRecesso(dateStr);  // ✅ Já importada na linha 16
    } catch {
        return false;
    }
}

// ============================================================================
// 🔍 PASSO 1: BUSCAR SLOTS DISPONÍVEIS
// ============================================================================

export async function fetchAvailableSlotsForDoctor({ doctorId, date }) {
    try {
        const res = await api.get("/api/appointments/available-slots", {
            params: { doctorId, date },
        });
        console.log("[BOOKING] Request slots", {
            baseURL: api.defaults.baseURL,
            doctorId,
            date
        });

        // sua rota já retorna um array de strings:
        // [ "08:00", "08:40", ... ]
        return res.data;
    } catch (err) {
        console.error("[AMANDA-BOOKING] available-slots falhou", {
            base: API_BASE,
            doctorId,
            date,
            status: err.response?.status,
            data: err.response?.data,
        });
        throw err;
    }
}

/**
 * Encontra candidatos de horários para a área de terapia
 */

export async function findAvailableSlots({
    therapyArea,
    specialties = [],
    preferredDay,
    preferredPeriod,
    preferredDate,
    daysAhead = 30,
    maxOptions = 2,  // ✅ NOVO: parar quando tiver o suficiente
}) {
    const doctorFilter = {
        active: true,
        specialty: therapyArea,
    };

    if (Array.isArray(specialties) && specialties.length) {
        doctorFilter.specialties = { $in: specialties };
    }

    console.log("🔍 [BOOKING] Buscando slots:", {
        therapyArea,
        preferredDay,
        preferredPeriod,
        preferredDate,
    });

    const doctors = await Doctor.find(doctorFilter).lean();
    if (!doctors.length) {
        return null;
    }

    const now = new Date();
    const today = startOfDay(now);
    const todayStr = format(today, "yyyy-MM-dd");

    // 👉 Se o cliente pediu uma data e ela é no futuro, começamos A PARTIR DELA
    let searchStart = getFirstAvailableDate();  // ✅ Já pula o recesso automaticamente

    if (preferredDate) {
        try {
            const pref = startOfDay(parseISO(preferredDate));
            const firstAvailable = getFirstAvailableDate();

            // Se a data pedida é depois da primeira disponível, usa ela
            if (isAfter(pref, firstAvailable)) {
                searchStart = pref;
            }
        } catch {
            // se der erro, ignora e segue com firstAvailable
        }
    }

    const allCandidates = [];

    let validDaysChecked = 0;
    let offset = 0;

    // ✅ Margem para filtrar período depois (busca um pouco mais que maxOptions)
    const targetCandidates = Math.max(maxOptions * 4, 8);

    // ✅ Helper para checar período (movido pra cá, ANTES do loop)
    const matchesPeriod = (time) => {
        if (!preferredPeriod) return true;
        return getTimePeriod(time) === preferredPeriod;
    };

    // ✅ Contador separado (O(1) em vez de O(n) por iteração)
    let validPeriodCount = 0;

    while (validDaysChecked < daysAhead) {
        // ✅ Guard anti-loop excessivo
        if (offset > daysAhead * 2) {
            console.warn("⚠️ [BOOKING] Loop excessivo detectado — interrompendo busca.");
            break;
        }

        // ✅ EARLY-BREAK: conta só candidatos QUE BATEM COM O PERÍODO
        if (validPeriodCount >= targetCandidates) {
            console.log(`✅ [BOOKING] Early-break: ${validPeriodCount} candidatos válidos para período "${preferredPeriod || 'qualquer'}"`);
            break;
        }

        const dateObj = addDays(searchStart, offset);
        const date = format(dateObj, "yyyy-MM-dd");
        offset++;

        // 🔴 ignora recesso SEM consumir daysAhead
        if (isDateBlocked(date)) {
            continue;
        }

        // ✅ percorre todos os médicos elegíveis
        for (const doctor of doctors) {
            // ✅ EARLY-BREAK interno (usa contador)
            if (validPeriodCount >= targetCandidates) break;

            const slots = await fetchAvailableSlotsForDoctor({
                doctorId: String(doctor._id),
                date,
            });

            if (!slots?.length) continue;

            for (const time of slots) {
                if (date === todayStr) {
                    const [h, m] = time.split(":");
                    const slotDate = new Date(dateObj);
                    slotDate.setHours(+h, +m, 0, 0);
                    if (slotDate <= now) continue;
                }

                const candidate = {
                    doctorId: String(doctor._id),
                    doctorName: doctor.fullName,
                    date,
                    time,
                    specialty: therapyArea,
                    requestedSpecialties: specialties,
                };

                allCandidates.push(candidate);

                // ✅ Incrementa contador só se bate com período
                if (matchesPeriod(time)) {
                    validPeriodCount++;
                }

                // ✅ EARLY-BREAK: usa contador de válidos
                if (validPeriodCount >= targetCandidates) break;
            }
        }

        validDaysChecked++;
    }

    if (!allCandidates.length) {
        console.log("ℹ️ [BOOKING] Nenhum slot disponível encontrado");
        return null;
    }

    // se preferredDate caiu dentro do recesso, aqui já não terá nada entre 19/12 e 05/01,
    // porque estamos pulando no laço acima.
    // Ou seja: se o paciente pedir "29/12", a busca começa em 29/12, mas os dias de recesso são ignorados,
    // então o primeiro horário vai ser logo DEPOIS do recesso (ex.: 06/01).

    const weekdayIndex = {
        sunday: 0,
        monday: 1,
        tuesday: 2,
        wednesday: 3,
        thursday: 4,
        friday: 5,
        saturday: 6,
    };

    const getDow = (dateStr) =>
        new Date(dateStr + "T12:00:00-03:00").getDay();
    const slotMatchesPeriod = (slot) => matchesPeriod(slot.time);

    // 1️⃣ Tenta escolher o primary no dia da semana preferido (segunda, quinta etc.)
    let primary = null;

    if (preferredDay && weekdayIndex[preferredDay] !== undefined) {
        const targetDow = weekdayIndex[preferredDay];

        const preferredDaySlots = allCandidates
            .filter(
                (slot) =>
                    getDow(slot.date) === targetDow && slotMatchesPeriod(slot)
            )
            .sort(
                (a, b) =>
                    a.date.localeCompare(b.date) ||
                    a.time.localeCompare(b.time)
            );

        if (preferredDaySlots.length) {
            primary = preferredDaySlots[0];
        }
    }


    // 2️⃣ Se não achar por dia da semana, pega o primeiro compatível com o período
    if (!primary) {
        const filtered = allCandidates
            .filter(slotMatchesPeriod)  // ✅ slotMatchesPeriod extrai slot.time

        primary = filtered[0] || null;
    }

    if (!primary) {
        if (allCandidates.length > 0) {
            console.warn(`⚠️ [BOOKING] ${allCandidates.length} candidatos encontrados, mas NENHUM no período "${preferredPeriod}"`);
        } else {
            console.log("ℹ️ [BOOKING] Nenhum slot sobrando após filtros");
        }
        return null;
    }

    // 3️⃣ Monta alternativas no MESMO período, tentando outro dia
    const primaryPeriod = getTimePeriod(primary.time);

    // ✅ Calcula quantas alternativas precisamos (maxOptions - 1, pois 1 é o primary)
    const maxAlternatives = Math.max(maxOptions - 1, 1);

    const samePeriodSlots = allCandidates
        .filter(
            (slot) =>
                !(slot.date === primary.date && slot.time === primary.time) &&
                getTimePeriod(slot.time) === primaryPeriod
        )
        .sort(
            (a, b) =>
                a.date.localeCompare(b.date) ||
                a.time.localeCompare(b.time)
        );

    const alternativesSamePeriod = [];

    // primeiro tenta dias diferentes
    for (const slot of samePeriodSlots) {
        if (alternativesSamePeriod.length >= maxAlternatives) break;
        if (slot.date !== primary.date) {
            alternativesSamePeriod.push(slot);
        }
    }

    // se ainda tiver espaço, preenche com outros horários no mesmo dia
    if (alternativesSamePeriod.length < maxAlternatives) {
        for (const slot of samePeriodSlots) {
            if (alternativesSamePeriod.length >= maxAlternatives) break;
            if (
                slot.date === primary.date &&
                !alternativesSamePeriod.some(
                    (s) => s.date === slot.date && s.time === slot.time
                )
            ) {
                alternativesSamePeriod.push(slot);
            }
        }
    }

    // ✅ alternativesOtherPeriod: só se maxOptions > 2
    const alternativesOtherPeriod = [];

    if (maxOptions > 2) {
        const otherPeriodSlots = allCandidates
            .filter(
                (slot) =>
                    !(slot.date === primary.date && slot.time === primary.time) &&
                    getTimePeriod(slot.time) !== primaryPeriod
            )
            .sort(
                (a, b) =>
                    a.date.localeCompare(b.date) ||
                    a.time.localeCompare(b.time)
            );

        // tenta pegar 2 de períodos diferentes primeiro (ex.: manhã e tarde)
        const seenPeriods = new Set();
        for (const slot of otherPeriodSlots) {
            if (alternativesOtherPeriod.length >= 2) break;
            const p = getTimePeriod(slot.time);
            if (!seenPeriods.has(p)) {
                seenPeriods.add(p);
                alternativesOtherPeriod.push(slot);
            }
        }

        // se não deu 2 ainda, completa com os próximos melhores
        if (alternativesOtherPeriod.length < 2) {
            for (const slot of otherPeriodSlots) {
                if (alternativesOtherPeriod.length >= 2) break;
                if (!alternativesOtherPeriod.some(s => s.date === slot.date && s.time === slot.time)) {
                    alternativesOtherPeriod.push(slot);
                }
            }
        }
    }


    return {
        primary,
        alternativesSamePeriod,
        alternativesOtherPeriod,
        all: allCandidates,
        maxOptions,  // ✅ retorna pra o orchestrator saber
    };
}


// ============================================================================

/**
 * ✅ COMMIT 4: Revalida o slot escolhido antes de pedir dados do paciente.
 * - Checa se o horário ainda está disponível no endpoint /available-slots
 * - Se NÃO estiver, tenta buscar um novo menu usando o mesmo contexto (quando fornecido)
 *
 * @param {object} chosenSlot {doctorId, date, time}
 * @param {object|null} refreshCtx {_meta} opcional (therapyArea, specialties, preferredDay, preferredPeriod, preferredDate, daysAhead)
 */
export async function validateSlotStillAvailable(chosenSlot, refreshCtx = null) {
    try {
        if (!chosenSlot?.doctorId || !chosenSlot?.date || !chosenSlot?.time) {
            return { isValid: false, freshSlots: null, reason: "MISSING_FIELDS" };
        }

        const availableTimes = await fetchAvailableSlotsForDoctor({
            doctorId: String(chosenSlot.doctorId),
            date: String(chosenSlot.date),
        });

        const wanted = String(chosenSlot.time).slice(0, 5);
        const stillOk = Array.isArray(availableTimes)
            ? availableTimes.some((t) => String(t).slice(0, 5) === wanted)
            : false;

        if (stillOk) {
            return { isValid: true, freshSlots: null };
        }

        // Se não existe mais, tenta buscar novas opções (se tivermos contexto)
        let freshSlots = null;

        const meta = refreshCtx && typeof refreshCtx === "object" ? refreshCtx : null;
        if (meta?.therapyArea) {
            freshSlots = await findAvailableSlots({
                therapyArea: meta.therapyArea,
                specialties: meta.specialties || [],
                preferredDay: meta.preferredDay || null,
                preferredPeriod: meta.preferredPeriod || null,
                preferredDate: meta.preferredDate || null,
                daysAhead: meta.daysAhead || 30,
            });

            // anexa meta para o fluxo continuar consistente
            if (freshSlots && typeof freshSlots === "object") {
                freshSlots._meta = {
                    therapyArea: meta.therapyArea,
                    specialties: meta.specialties || [],
                    preferredDay: meta.preferredDay || null,
                    preferredPeriod: meta.preferredPeriod || null,
                    preferredDate: meta.preferredDate || null,
                    daysAhead: meta.daysAhead || 30,
                    createdAt: new Date().toISOString(),
                };
            }
        }

        return { isValid: false, freshSlots, reason: "SLOT_GONE" };
    } catch (error) {
        console.error("Erro ao revalidar slot:", error?.message || error);
        return { isValid: false, freshSlots: null, reason: "ERROR" };
    }
}

// 📅 PASSO 2 + 3: CRIAR PACIENTE + AGENDAR (FLUXO COMPLETO)
// ============================================================================

export async function autoBookAppointment({
    lead,
    chosenSlot,
    patientInfo, // { fullName, birthDate, phone, email }
}) {
    bookingStats.totalAttempts++;

    try {
        console.log("🎯 [AUTO-BOOKING] Iniciando fluxo completo");

        const { fullName, birthDate, phone, email } = patientInfo;

        // ====================================================================
        // 1️⃣ Criar / encontrar paciente via POST /api/patients/add
        // ====================================================================
        console.log("👤 [BOOKING] Criando/buscando paciente...");

        let patientId = null;

        try {
            const patientResponse = await api.post("/api/patients/add", {
                fullName,
                dateOfBirth: birthDate,
                phone,
                email: email || undefined,
            });

            if (patientResponse.data?.success && patientResponse.data?.data?._id) {
                patientId = patientResponse.data.data._id;
                console.log("✅ [BOOKING] Paciente criado:", patientId);
            }
        } catch (patientError) {
            // Se retornar 409 (duplicado), pega o ID existente
            if (
                patientError.response?.status === 409 &&
                patientError.response.data?.existingId
            ) {
                patientId = patientError.response.data.existingId;
                console.log("✅ [BOOKING] Paciente já existe:", patientId);
            } else {
                console.error(
                    "❌ [BOOKING] Erro ao criar paciente:",
                    patientError.response?.data || patientError.message
                );
                throw patientError;
            }
        }

        if (!patientId) {
            throw new Error("Não foi possível criar/encontrar o paciente");
        }

        // ====================================================================
        // 2️⃣ Criar agendamento via POST /api/appointments
        //    (sua rota já cuida de Payment + Session + Appointment)
        // ====================================================================
        console.log("📅 [BOOKING] Criando agendamento...");

        const appointmentPayload = {
            patientId,
            doctorId: chosenSlot.doctorId,
            specialty:
                chosenSlot.specialty || lead?.therapyArea || "fonoaudiologia",
            date: chosenSlot.date, // string yyyy-MM-dd
            time: chosenSlot.time, // string HH:mm
            serviceType: "evaluation",
            sessionType: "avaliacao",
            paymentMethod: "pix",
            paymentAmount: 200,
            status: "scheduled",
            notes: "[AGENDADO AUTOMATICAMENTE VIA AMANDA/WHATSAPP]",
            isAdvancePayment: false,
        };

        const appointmentResponse = await api.post(
            "/api/appointments",
            appointmentPayload
        );

        if (!appointmentResponse.data?.success) {
            bookingStats.errors++;
            throw new Error(
                appointmentResponse.data?.message || "Erro desconhecido ao criar agendamento"
            );
        }

        const appointmentData = appointmentResponse.data.data;

        console.log("✅ [BOOKING] Agendamento criado com sucesso!", {
            appointmentId: appointmentData.appointment?._id,
            paymentId: appointmentData._id,
        });

        bookingStats.successful++;

        return {
            success: true,
            patientId,
            appointment: appointmentData.appointment,
            payment: appointmentData,
            session: appointmentData.session,
        };
    } catch (error) {
        console.error(
            "❌ [AUTO-BOOKING] Erro:",
            error.message,
            error.response?.data
        );

        const message = error.response?.data?.message || error.message || "";

        const isConflict =
            error.response?.status === 409 ||
            /conflito|conflict|occupied|preenchido/i.test(message);

        if (isConflict) {
            bookingStats.conflicts++;
            return {
                success: false,
                code: "TIME_CONFLICT",
                error: "Horário não está mais disponível",
            };
        }

        bookingStats.errors++;
        return {
            success: false,
            error: message,
        };
    }
}

// ============================================================================
// 🛠️ FUNÇÕES AUXILIARES
// ============================================================================

/**
 * Determina se é manhã ou tarde baseado na hora
 */
export function getTimePeriod(time) {
    const hour = parseInt(time.split(":")[0], 10);
    if (hour < 12) return "manhã";  // com til
    if (hour < 18) return "tarde";
    return "noite";
}

/**
 * Formata data yyyy-MM-dd para dd/MM/yyyy
 */
export function formatDatePtBr(dateStr) {
    const [year, month, day] = dateStr.split("-");
    return `${day}/${month}/${year}`;
}

/**
 * Extrai slot escolhido da mensagem do usuário
 */
export function pickSlotFromUserReply(text, availableSlots, opts = {}) {
    if (!availableSlots) return null;

    const normalized = (text || "").toLowerCase().trim();
    const strict = Boolean(opts?.strict);
    const noFallback = Boolean(opts?.noFallback);

    // Monta a lista A..F (ordem: primary, samePeriod..., otherPeriod...)
    const primary = availableSlots.primary || null;
    const same = availableSlots.alternativesSamePeriod || [];
    const other = availableSlots.alternativesOtherPeriod || [];

    const allSlots = [primary, ...same, ...other].filter(Boolean);

    if (allSlots.length === 0) return null;

    // Helper: pega slot por letra A-F
    const pickByLetter = (letter) => {
        const L = (letter || "").toUpperCase();

        if (L === "A") return primary;
        if (L === "B") return same[0] || null;
        if (L === "C") return same[1] || null;
        if (L === "D") return same[2] || null;
        if (L === "E") return other[0] || null;
        if (L === "F") return other[1] || null;

        return null;
    };

    // 1) Letra A-F (aceita "A", "A)", "opção B", "alternativa c", "letra d")
    const letterMatch = normalized.match(
        /(?:^|\b)(?:op(?:c|ç)[aã]o|alternativa|letra)?\s*([a-f])(?:\b|[\)\.\:\-]|$)/i
    );
    if (letterMatch?.[1]) {
        const picked = pickByLetter(letterMatch[1]);
        if (picked) return picked;
    }

    // 2) Número 1-6 (mapeia para A-F na mesma ordem)
    const numMatch = normalized.match(
        /(?:^|\b)(?:op(?:c|ç)[aã]o|alternativa)?\s*([1-6])(?:\b|[\)\.\:\-]|$)/
    );
    if (numMatch?.[1]) {
        const idx = parseInt(numMatch[1], 10) - 1;
        return allSlots[idx] || null;
    }

    // 3) Filtro por período (se a pessoa falar "de manhã/tarde/noite",
    // tenta retornar o PRIMEIRO slot daquele período)
    const wantsMorning = /\b(manh[ãa]|cedo)\b/.test(normalized);
    const wantsAfternoon = /\b(tarde)\b/.test(normalized);
    const wantsNight = /\b(noite)\b/.test(normalized);

    if (wantsMorning || wantsAfternoon || wantsNight) {
        const desired =
            wantsMorning ? "manha" : wantsAfternoon ? "tarde" : "noite";

        const slotByPeriod = allSlots.find((s) => getTimePeriod(s.time) === desired);
        if (slotByPeriod) return slotByPeriod;

        // falou período mas não tem nenhum slot nele
        return null;
    }

    // 4) Dia da semana + horário ("quinta 14:00" ou "quinta 14h")
    const weekdayMatch = normalized.match(
        /\b(segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo)\b/
    );
    const timeMatch = normalized.match(/\b(\d{1,2}):(\d{2})\b|\b(\d{1,2})\s*h\b/);

    if (weekdayMatch && timeMatch) {
        const targetDay = weekdayMatch[1]
            .replace("terça", "terca")
            .replace("sábado", "sabado");

        const hourRaw = timeMatch[1] ?? timeMatch[3];
        const minRaw = timeMatch[2] ?? "00";
        const targetHour = String(hourRaw).padStart(2, "0");
        const targetTime = `${targetHour}:${minRaw}`;

        for (const slot of allSlots) {
            const slotDate = new Date(slot.date + "T12:00:00-03:00");
            const slotDay = ["domingo", "segunda", "terca", "quarta", "quinta", "sexta", "sabado"][slotDate.getDay()];

            if (slotDay === targetDay && slot.time.startsWith(targetTime)) {
                return slot;
            }
        }
    }

    // 5) Fallback
    // - modo padrão: se não entendeu, devolve a primary (A)
    // - modo strict: se não entendeu, devolve null (pra você re-perguntar sem “chutar”)
    return (strict || noFallback) ? null : primary;
}



export async function bookFixedSlot({
    patientId: providedPatientId = null, // 👈 novo
    patientInfo,
    doctorId,
    specialty,
    date,
    time,
    notes = "",
    sessionType = "avaliacao",
    serviceType = "individual_session",
    paymentMethod = "pix",
    sessionValue = 0,                    // 👈 novo (valor real)
    status = "scheduled",
    packageId = null,                    // 👈 novo
}) {
    bookingStats.totalAttempts++;

    try {
        // 1) resolve patientId (usa o que veio, senão cria/busca)
        let patientId = providedPatientId;

        if (!patientId) {
            const { fullName, birthDate, phone, email } = patientInfo || {};
            const missing = [];
            if (!fullName) missing.push("fullName");
            if (!birthDate) missing.push("birthDate");
            if (!phone) missing.push("phone");
            if (missing.length) {
                return { success: false, code: "MISSING_FIELDS", error: `Campos faltando: ${missing.join(", ")}` };
            }

            try {
                const patientResponse = await api.post("/api/patients/add", {
                    fullName,
                    dateOfBirth: birthDate,
                    phone,
                    email: email || undefined,
                });

                if (patientResponse.data?.success && patientResponse.data?.data?._id) {
                    patientId = patientResponse.data.data._id;
                }
            } catch (patientError) {
                if (patientError.response?.status === 409 && patientError.response.data?.existingId) {
                    patientId = patientError.response.data.existingId;
                } else {
                    throw patientError;
                }
            }

            if (!patientId) {
                return { success: false, code: "PATIENT_ERROR", error: "Não foi possível criar/encontrar o paciente" };
            }
        }

        // 2) calcula paymentAmount correto
        const isPackage = serviceType === "package_session";
        const paymentAmount = isPackage ? 0 : Number(sessionValue) || 0;

        if (!isPackage && paymentAmount <= 0) {
            return { success: false, code: "INVALID_VALUE", error: "sessionValue deve ser > 0 para atendimentos avulsos" };
        }

        // 3) cria agendamento no CRM
        const appointmentPayload = {
            patientId,
            doctorId,
            specialty: specialty || "fonoaudiologia",
            date,
            time,
            serviceType,
            sessionType,
            paymentMethod,
            paymentAmount,
            status,
            notes: notes || "[IMPORTADO DA AGENDA PROVISÓRIA]",
            isAdvancePayment: false,
            ...(isPackage ? { packageId } : {}),
        };

        const appointmentResponse = await api.post("/api/appointments", appointmentPayload);

        if (!appointmentResponse.data?.success) {
            bookingStats.errors++;
            return {
                success: false,
                code: appointmentResponse.data?.code || "APPOINTMENT_ERROR",
                error: appointmentResponse.data?.message || "Erro ao criar agendamento",
            };
        }

        const appointmentData = appointmentResponse.data.data;
        bookingStats.successful++;

        return {
            success: true,
            patientId,
            appointment: appointmentData.appointment,
            payment: appointmentData,
            session: appointmentData.session,
        };
    } catch (error) {
        const message = error.response?.data?.message || error.message || "";
        const isConflict = error.response?.status === 409 || /conflito|conflict|occupied|preenchido/i.test(message);

        if (isConflict) {
            bookingStats.conflicts++;
            return { success: false, code: "TIME_CONFLICT", error: "Horário não está mais disponível" };
        }

        bookingStats.errors++;
        return { success: false, code: "INTERNAL_ERROR", error: message };
    }
}


/**
 * Formata slot para exibição humana
 */
export function formatSlot(slot) {
    const date = formatDatePtBr(slot.date);
    const time = slot.time.slice(0, 5);
    const weekday = new Date(slot.date + "T12:00:00-03:00").toLocaleDateString(
        "pt-BR",
        { weekday: "long" }
    );

    return `${weekday.charAt(0).toUpperCase() + weekday.slice(1)}, ${date} às ${time} - ${slot.doctorName}`;
}


// ============================================================================
// 🧷 Helper único: montar opções A..F (para NÃO duplicar em orquestrador/controller)
// ============================================================================
export function buildSlotOptions(availableSlots) {
    const letters = ["A", "B", "C", "D", "E", "F"];
    if (!availableSlots) return [];

    const primary = availableSlots.primary || null;
    const same = availableSlots.alternativesSamePeriod || [];
    const other = availableSlots.alternativesOtherPeriod || [];

    const ordered = [primary, ...same, ...other].filter(Boolean).slice(0, 6);

    return ordered.map((slot, idx) => ({
        letter: letters[idx],
        slot,
        text: `${letters[idx]}) ${formatSlot(slot)}`,
    }));
}

// ✅ Ordena os slots na ordem do menu (primary + samePeriod + otherPeriod)
export function buildOrderedSlotOptions(slotsCtx = {}) {
    return [
        slotsCtx.primary,
        ...(slotsCtx.alternativesSamePeriod || []),
        ...(slotsCtx.alternativesOtherPeriod || []),
    ].filter(Boolean);
}

