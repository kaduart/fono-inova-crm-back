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

// 🔗 Base interna: primeiro INTERNAL_BASE_URL, depois BACKEND_URL_PRD, depois localhost
const API_BASE =
    process.env.INTERNAL_BASE_URL ||
    process.env.BACKEND_URL_PRD;

const ADMIN_TOKEN = process.env.ADMIN_API_TOKEN;

// ============================================================================
// 🌐 Cliente HTTP interno com token da Amanda
// ============================================================================
const api = axios.create({
    baseURL: API_BASE,
    timeout: 8000,
});

api.interceptors.request.use((config) => {
    if (!ADMIN_TOKEN) {
        console.warn("[AMANDA-BOOKING] ADMIN_API_TOKEN não definido!");
    } else {
        config.headers.Authorization = `Bearer ${ADMIN_TOKEN}`;
    }

    // garante content-type pra POST/PUT/PATCH
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


const RECESSO_START = parseISO("2025-12-19");
const RECESSO_END = parseISO("2026-01-04");

export function isDateBlocked(dateStr) {
    try {
        const d = parseISO(dateStr); // "yyyy-MM-dd"
        return isWithinInterval(d, { start: RECESSO_START, end: RECESSO_END });
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

        // sua rota já retorna um array de strings:
        // [ "08:00", "08:40", ... ]
        return res.data;
    } catch (err) {
        console.error(
            "[AMANDA-BOOKING] Erro ao buscar slots",
            { doctorId, date, status: err.response?.status },
            err.response?.data
        );
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
    let searchStart = today;

    if (preferredDate) {
        try {
            const pref = startOfDay(parseISO(preferredDate));

            // Se a data pedida é depois de hoje, começamos dali
            if (isAfter(pref, today)) {
                searchStart = pref;
            }
        } catch {
            // se der erro, ignora e segue com hoje
        }
    }

    const allCandidates = [];

    for (const doctor of doctors) {
        for (let i = 0; i < daysAhead; i++) {
            const dateObj = addDays(searchStart, i);
            const date = format(dateObj, "yyyy-MM-dd");

            try {
                const slots = await fetchAvailableSlotsForDoctor({
                    doctorId: doctor._id.toString(),
                    date,
                });

                if (!slots?.length) continue;

                for (const time of slots) {
                    // ❌ Pula qualquer horário em dia de recesso
                    if (isDateBlocked(date)) continue;

                    // ❌ Pula horários que já passaram HOJE
                    if (date === todayStr) {
                        const [hStr, mStr] = time.split(":");
                        const slotDate = new Date(dateObj);
                        slotDate.setHours(parseInt(hStr, 10), parseInt(mStr, 10), 0, 0);

                        if (slotDate <= now) {
                            continue; // já passou
                        }
                    }

                    allCandidates.push({
                        doctorId: doctor._id.toString(),
                        doctorName: doctor.fullName,
                        date,
                        time,
                        specialty: therapyArea,
                        requestedSpecialties: specialties,
                    });
                }
            } catch (_err) {
                // erro de um médico/dia não derruba o resto
                continue;
            }
        }
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

    const matchesPeriod = (slot) => {
        if (!preferredPeriod) return true;
        return getTimePeriod(slot.time) === preferredPeriod;
    };

    // 1️⃣ Tenta escolher o primary no dia da semana preferido (segunda, quinta etc.)
    let primary = null;

    if (preferredDay && weekdayIndex[preferredDay] !== undefined) {
        const targetDow = weekdayIndex[preferredDay];

        const preferredDaySlots = allCandidates
            .filter(
                (slot) =>
                    getDow(slot.date) === targetDow && matchesPeriod(slot)
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
            .filter(matchesPeriod)
            .sort(
                (a, b) =>
                    a.date.localeCompare(b.date) ||
                    a.time.localeCompare(b.time)
            );

        primary = filtered[0] || allCandidates[0];
    }

    if (!primary) {
        console.log("ℹ️ [BOOKING] Nenhum slot sobrando após filtros");
        return null;
    }

    // 3️⃣ Monta alternativas no MESMO período, tentando outro dia
    const primaryPeriod = getTimePeriod(primary.time);

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
        if (alternativesSamePeriod.length >= 3) break;
        if (slot.date !== primary.date) {
            alternativesSamePeriod.push(slot);
        }
    }

    // se ainda tiver espaço, preenche com outros horários no mesmo dia
    if (alternativesSamePeriod.length < 3) {
        for (const slot of samePeriodSlots) {
            if (alternativesSamePeriod.length >= 3) break;
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

    return {
        primary,
        alternativesSamePeriod,
        all: allCandidates,
    };
}


// ============================================================================
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
            serviceType: "individual_session",
            sessionType: "avaliacao",
            paymentMethod: "to_define",
            paymentAmount: 0,
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
 * Filtra horários por período (manhã/tarde)
 */
function filterSlotsByPeriod(slots, period) {
    if (!period) return slots;

    const normalized = period.toLowerCase();

    return slots.filter((time) => {
        const hour = parseInt(time.split(":")[0], 10);

        if (normalized.includes("manh") || normalized.includes("cedo")) {
            return hour >= 7 && hour < 12;
        }

        if (normalized.includes("tard")) {
            return hour >= 12 && hour < 18;
        }

        return true;
    });
}

/**
 * Determina se é manhã ou tarde baseado na hora
 */
export function getTimePeriod(time) {
    const hour = parseInt(time.split(":")[0], 10);
    if (hour < 12) return "manha";
    if (hour < 18) return "tarde";
    return "noite";
}


/**
 * Extrai data de texto do usuário (hoje, amanhã, segunda, etc.)
 */
function parseDateFromUserInput(text) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const normalized = text.toLowerCase();

    if (/\bhoje\b/.test(normalized)) return today;

    if (/\bamanh[ãa]\b/.test(normalized)) {
        const tomorrow = new Date(today);
        tomorrow.setDate(today.getDate() + 1);
        return tomorrow;
    }

    const weekdays = {
        domingo: 0,
        segunda: 1,
        terça: 2,
        terca: 2,
        quarta: 3,
        quinta: 4,
        sexta: 5,
        sábado: 6,
        sabado: 6,
    };

    for (const [day, targetDay] of Object.entries(weekdays)) {
        if (normalized.includes(day)) {
            const currentDay = today.getDay();
            let daysToAdd = targetDay - currentDay;
            if (daysToAdd <= 0) daysToAdd += 7;

            const result = new Date(today);
            result.setDate(today.getDate() + daysToAdd);
            return result;
        }
    }

    return today;
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
export function pickSlotFromUserReply(text, availableSlots) {
    if (!availableSlots?.primary) return null;

    const normalized = text.toLowerCase();

    const wantsMorning = /\b(manh[ãa]|cedo)\b/.test(normalized);
    const wantsAfternoon = /\b(tarde)\b/.test(normalized);
    const wantsNight = /\b(noite)\b/.test(normalized);

    const primaryPeriod = getTimePeriod(availableSlots.primary.time);

    if (wantsMorning && primaryPeriod !== "manha") return null;
    if (wantsAfternoon && primaryPeriod !== "tarde") return null;
    if (wantsNight && primaryPeriod !== "noite") return null;


    // "primeiro", "1", "opção 1"
    if (/\b(primeiro|1|op[çc][aã]o\s*1)\b/.test(normalized)) {
        return availableSlots.primary;
    }

    // "segundo", "2"
    if (
        /\b(segundo|2|op[çc][aã]o\s*2)\b/.test(normalized) &&
        availableSlots.alternativesSamePeriod?.[0]
    ) {
        return availableSlots.alternativesSamePeriod[0];
    }

    // "terceiro", "3"
    if (
        /\b(terceiro|3|op[çc][aã]o\s*3)\b/.test(normalized) &&
        availableSlots.alternativesSamePeriod?.[1]
    ) {
        return availableSlots.alternativesSamePeriod[1];
    }

    // Tenta extrair dia + horário específico
    const weekdayMatch = normalized.match(
        /\b(segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo)\b/
    );
    const timeMatch = normalized.match(/\b(\d{1,2}):(\d{2})\b|\b(\d{1,2})\s*h\b/);

    if (weekdayMatch && timeMatch) {
        const targetDay = weekdayMatch[1];
        const targetHour = timeMatch[1].padStart(2, "0");
        const targetMin = timeMatch[2] || "00";
        const targetTime = `${targetHour}:${targetMin}`;

        const allSlots = [
            availableSlots.primary,
            ...(availableSlots.alternativesSamePeriod || []),
            ...(availableSlots.alternativesOtherPeriod || []),
        ];

        for (const slot of allSlots) {
            const slotDate = new Date(slot.date + "T12:00:00-03:00");
            const slotDay = [
                "domingo",
                "segunda",
                "terça",
                "quarta",
                "quinta",
                "sexta",
                "sábado",
            ][slotDate.getDay()];

            if (slotDay === targetDay && slot.time.startsWith(targetTime)) {
                return slot;
            }
        }
    }

    // Fallback: retorna o primeiro
    return availableSlots.primary;
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
