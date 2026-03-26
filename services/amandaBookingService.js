// ============================================================================
// 🤖 AMANDA AUTO-BOOKING - VERSÃO CONSOLIDADA
// ============================================================================
// Arquivo: services/amandaBookingService.js

import axios from "axios";
import {
    addDays,
    format,
    isAfter,
    parseISO,
    startOfDay
} from "date-fns";
import { getFirstAvailableDate, isInRecesso } from '../config/clinic.js';
import Doctor from "../models/Doctor.js";
import { sendTextMessage } from './whatsappService.js';

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
    timeout: 30000,  // ⬆️ Aumentado de 8000 para 30000ms (30s) - Render é lento
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

// ============================================================================
// 🛠️ HELPERS DEFENSIVOS (ANTI-BUG)
// ============================================================================

function extractTime(slot) {
    if (!slot) return null;
    if (typeof slot === "string") return slot;
    if (typeof slot === "object" && slot.time) return slot.time;
    return null;
}

function normalizePeriodCanonical(p) {
    if (!p) return null;
    const n = String(p)
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z]/g, "");

    if (n.includes("manh")) return "manha";
    if (n.includes("tard")) return "tarde";
    if (n.includes("noit")) return "noite";
    return null;
}

export function isDateBlocked(dateStr) {
    try {
        return isInRecesso(dateStr);
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
    maxOptions = 2,
}) {
    const MAX_REQUESTS = 25;
    let requestCount = 0;

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

    let searchStart = getFirstAvailableDate();

    if (preferredDate) {
        try {
            const pref = startOfDay(parseISO(preferredDate));
            const firstAvailable = getFirstAvailableDate();
            if (isAfter(pref, firstAvailable)) {
                searchStart = pref;
            }
        } catch {
            // ignora erro
        }
    }

    const allCandidates = [];
    let validDaysChecked = 0;
    let offset = 0;
    const targetCandidates = Math.max(maxOptions * 4, 8);

    const matchesPeriod = (slot) => {
        const want = normalizePeriodCanonical(preferredPeriod);
        if (!want) return true;

        const time = extractTime(slot);
        if (!time) return false;

        const slotPeriod = normalizePeriodCanonical(getTimePeriod(time));
        return slotPeriod === want;
    };

    let validPeriodCount = 0;

    while (validDaysChecked < daysAhead) {
        if (requestCount >= MAX_REQUESTS) {
            console.warn("⚠️ [BOOKING] Busca abortada por excesso de requisições");
            break;
        }

        if (offset > daysAhead * 2) {
            console.warn("⚠️ [BOOKING] Loop excessivo detectado — interrompendo busca.");
            break;
        }

        if (validPeriodCount >= targetCandidates) {
            console.log(`✅ [BOOKING] Early-break: ${validPeriodCount} candidatos válidos para período "${preferredPeriod || 'qualquer'}"`);
            break;
        }

        const dateObj = addDays(searchStart, offset);
        const date = format(dateObj, "yyyy-MM-dd");
        offset++;

        if (isDateBlocked(date)) {
            continue;
        }

        // Consulta todos os médicos do dia em paralelo (em vez de sequencial)
        const remainingBudget = MAX_REQUESTS - requestCount;
        if (remainingBudget <= 0) {
            console.warn("⚠️ [BOOKING] Limite de requisições atingido — abortando busca.");
            break;
        }
        const doctorsToQuery = doctors.slice(0, remainingBudget);
        requestCount += doctorsToQuery.length;

        const dayResults = await Promise.all(
            doctorsToQuery.map(doctor =>
                fetchAvailableSlotsForDoctor({ doctorId: String(doctor._id), date })
                    .catch(() => null)
            )
        );

        for (let i = 0; i < doctorsToQuery.length; i++) {
            const doctor = doctorsToQuery[i];
            const slots = dayResults[i];

            if (!slots?.length) continue;

            for (const slot of slots) {
                // 🆕 NOVO: Suporta novo formato { time, available, reason, label }
                // e formato antigo string
                const slotTime = typeof slot === 'string' ? slot : slot.time;
                const isAvailable = typeof slot === 'string' ? true : slot.available;
                
                // Pula slots indisponíveis (feriados, ocupados, etc)
                if (!isAvailable) continue;
                
                if (date === todayStr) {
                    const [h, m] = slotTime.split(":");
                    const slotDate = new Date(dateObj);
                    slotDate.setHours(+h, +m, 0, 0);
                    if (slotDate <= now) continue;
                }

                allCandidates.push({
                    doctorId: String(doctor._id),
                    doctorName: doctor.fullName,
                    date,
                    time: slotTime,
                    specialty: therapyArea,
                    requestedSpecialties: specialties,
                });

                if (matchesPeriod(slotTime)) {
                    validPeriodCount++;
                }

                if (validPeriodCount >= targetCandidates) break;
            }

            if (validPeriodCount >= targetCandidates) break;
        }

        validDaysChecked++;
    }

    if (!allCandidates.length) {
        console.log("ℹ️ [BOOKING] Nenhum slot disponível encontrado");
        return null;
    }

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

    let primary = null;

    if (preferredDay && weekdayIndex[preferredDay] !== undefined) {
        const targetDow = weekdayIndex[preferredDay];
        const preferredDaySlots = allCandidates
            .filter((slot) =>
                getDow(slot.date) === targetDow && matchesPeriod(slot)
            )
            .sort((a, b) =>
                a.date.localeCompare(b.date) || a.time.localeCompare(b.time)
            );

        if (preferredDaySlots.length) {
            primary = preferredDaySlots[0];
        }
    }

    if (!primary) {
        const filtered = allCandidates.filter(slot => matchesPeriod(slot));
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

    const primaryPeriod = getTimePeriod(primary.time);
    const maxAlternatives = Math.max(maxOptions - 1, 1);

    const samePeriodSlots = allCandidates
        .filter((slot) =>
            !(slot.date === primary.date && slot.time === primary.time) &&
            getTimePeriod(slot.time) === primaryPeriod
        )
        .sort((a, b) =>
            a.date.localeCompare(b.date) || a.time.localeCompare(b.time)
        );

    const alternativesSamePeriod = [];

    for (const slot of samePeriodSlots) {
        if (alternativesSamePeriod.length >= maxAlternatives) break;
        if (slot.date !== primary.date) {
            alternativesSamePeriod.push(slot);
        }
    }

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

    const alternativesOtherPeriod = [];

    if (maxOptions > 2) {
        const otherPeriodSlots = allCandidates
            .filter((slot) =>
                !(slot.date === primary.date && slot.time === primary.time) &&
                getTimePeriod(slot.time) !== primaryPeriod
            )
            .sort((a, b) =>
                a.date.localeCompare(b.date) || a.time.localeCompare(b.time)
            );

        const seenPeriods = new Set();
        for (const slot of otherPeriodSlots) {
            if (alternativesOtherPeriod.length >= 2) break;
            const p = getTimePeriod(slot.time);
            if (!seenPeriods.has(p)) {
                seenPeriods.add(p);
                alternativesOtherPeriod.push(slot);
            }
        }

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
        maxOptions,
    };
}

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

export async function autoBookAppointment({
    lead,
    chosenSlot,
    patientInfo,
}) {
    bookingStats.totalAttempts++;

    try {
        console.log("🎯 [AUTO-BOOKING] Iniciando fluxo completo");

        const { fullName, birthDate, phone, email } = patientInfo;

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

        console.log("📅 [BOOKING] Criando agendamento...");

        const appointmentPayload = {
            patientId,
            doctorId: chosenSlot.doctorId,
            specialty: chosenSlot.specialty || lead?.therapyArea || "fonoaudiologia",
            date: chosenSlot.date,
            time: chosenSlot.time,
            serviceType: "evaluation",
            sessionType: "avaliacao",
            paymentMethod: "pix",
            paymentAmount: 200,
            operationalStatus: "scheduled",
            notes: "[AGENDADO AUTOMATICAMENTE VIA AMANDA/WHATSAPP]",
            isAdvancePayment: false,
            source: "amandaAI", // 📈 ROI
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

export function getTimePeriod(time) {
    if (!time || typeof time !== "string") return null;

    const hour = parseInt(time.split(":")[0], 10);

    if (isNaN(hour)) return null;

    if (hour < 12) return "manha";
    if (hour < 18) return "tarde";
    return "noite";
}

export function formatDatePtBr(dateStr) {
    const [year, month, day] = dateStr.split("-");
    return `${day}/${month}/${year}`;
}

export function pickSlotFromUserReply(text, availableSlots, opts = {}) {
    if (!availableSlots) return null;

    const normalized = (text || "").toLowerCase().trim();
    const strict = Boolean(opts?.strict);
    const noFallback = Boolean(opts?.noFallback);

    const primary = availableSlots.primary || null;
    const same = availableSlots.alternativesSamePeriod || [];
    const other = availableSlots.alternativesOtherPeriod || [];

    const allSlots = [primary, ...same, ...other].filter(Boolean);

    if (allSlots.length === 0) return null;

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

    const letterMatch = normalized.match(
        /(?:^|\b)(?:op(?:c|ç)[aã]o|alternativa|letra)?\s*([a-f])(?:\b|[\)\.\:\-]|$)/i
    );
    if (letterMatch?.[1]) {
        const picked = pickByLetter(letterMatch[1]);
        if (picked) return picked;
    }

    const numMatch = normalized.match(
        /(?:^|\b)(?:op(?:c|ç)[aã]o|alternativa)?\s*([1-6])(?:\b|[\)\.\:\-]|$)/
    );
    if (numMatch?.[1]) {
        const idx = parseInt(numMatch[1], 10) - 1;
        return allSlots[idx] || null;
    }

    const wantsMorning = /\b(manh[ãa]|cedo)\b/.test(normalized);
    const wantsAfternoon = /\b(tarde)\b/.test(normalized);
    const wantsNight = /\b(noite)\b/.test(normalized);

    if (wantsMorning || wantsAfternoon || wantsNight) {
        const desired =
            wantsMorning ? "manha" : wantsAfternoon ? "tarde" : "noite";

        const slotByPeriod = allSlots.find((s) => getTimePeriod(s.time) === desired);
        if (slotByPeriod) return slotByPeriod;

        return null;
    }

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

    return (strict || noFallback) ? null : primary;
}

export async function bookFixedSlot({
    patientId: providedPatientId = null,
    patientInfo,
    doctorId,
    specialty,
    date,
    time,
    notes = "",
    sessionType = "avaliacao",
    serviceType = "individual_session",
    paymentMethod = "pix",
    sessionValue = 0,
    operationalStatus = "scheduled",
    packageId = null,
    source = "outro",
    preAgendamentoId = null,
}) {
    bookingStats.totalAttempts++;

    try {
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

        const isPackage = serviceType === "package_session";
        const paymentAmount = isPackage ? 0 : Number(sessionValue) || 0;

        if (!isPackage && paymentAmount < 0) {
            return { success: false, code: "INVALID_VALUE", error: "sessionValue não pode ser negativo" };
        }

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
            operationalStatus,
            notes: notes || "[IMPORTADO DA AGENDA PROVISÓRIA]",
            isAdvancePayment: false,
            ...(isPackage ? { packageId } : {}),
            source,             // 📈 ROI
            preAgendamentoId,    // 📈 ROI
        };

        console.log(`[bookFixedSlot] 📤 Enviando para /api/appointments:`, {
            patientId, doctorId, date, time, serviceType, sessionValue
        });
        
        const appointmentResponse = await api.post("/api/appointments", appointmentPayload);
        
        console.log(`[bookFixedSlot] 📥 Resposta da API:`, {
            success: appointmentResponse.data?.success,
            hasData: !!appointmentResponse.data?.data,
            hasAppointment: !!appointmentResponse.data?.data?.appointment,
            hasPayment: !!appointmentResponse.data?.data?._id, // payment retorna no data
            appointmentId: appointmentResponse.data?.data?.appointment?._id,
            paymentId: appointmentResponse.data?.data?._id
        });

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

        // 📲 NOTIFICAÇÃO WPP AO DONO — fire-and-forget, não bloqueia resposta
        const ownerPhone = process.env.OWNER_NOTIFY_PHONE;
        if (ownerPhone) {
            Doctor.findById(doctorId).select('fullName').lean()
                .then(doctorDoc => {
                    const doctorName = doctorDoc?.fullName || 'N/A';
                    const patientName = patientInfo?.fullName || 'Paciente';
                    const formattedDate = date ? format(parseISO(date), 'dd/MM/yyyy') : date;
                    const sourceLabel =
                        source === 'amandaAI' ? 'Amanda AI' :
                        source === 'agenda_externa' ? 'Agenda Externa' :
                        source;
                    const msg =
                        `🗓️ *Novo agendamento* via ${sourceLabel}\n\n` +
                        `👤 *Paciente:* ${patientName}\n` +
                        `📅 *Data:* ${formattedDate}\n` +
                        `⏰ *Horário:* ${time}\n` +
                        `👩‍⚕️ *Profissional:* ${doctorName}\n` +
                        `🩺 *Especialidade:* ${specialty || 'N/A'}\n` +
                        `📋 *Tipo:* ${sessionType}`;
                    return sendTextMessage({ to: ownerPhone, text: msg, sentBy: 'system' });
                })
                .then(() => console.log('[bookFixedSlot] ✅ Notificação WPP enviada ao dono'))
                .catch(e => console.warn('[bookFixedSlot] ⚠️ WPP falhou (ignorado):', e.message));
        }

        // 🔹 O payment retornado tem o campo 'appointment' com o ID do agendamento criado
        // Garantimos que retornamos um objeto com _id
        let createdAppointment = null;
        if (appointmentData.appointment) {
            const appointmentId = typeof appointmentData.appointment === 'object' 
                ? appointmentData.appointment._id 
                : appointmentData.appointment;
            
            try {
                const apptResponse = await api.get(`/api/appointments/${appointmentId}`);
                if (apptResponse.data?.success) {
                    createdAppointment = apptResponse.data.data;
                }
            } catch (e) {
                console.warn('[bookFixedSlot] Erro ao buscar appointment:', e.message);
            }
            
            // Se não conseguiu buscar, cria um objeto mínimo com o ID
            if (!createdAppointment) {
                createdAppointment = { 
                    _id: appointmentId,
                    id: appointmentId 
                };
            }
        }

        console.log(`[bookFixedSlot] ✅ Retornando sucesso:`, {
            patientId,
            appointmentId: createdAppointment?._id,
            paymentId: appointmentData?._id,
            sessionId: appointmentData?.session
        });
        
        return {
            success: true,
            patientId,
            appointment: createdAppointment,
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

export function formatSlot(slot) {
    if (!slot?.doctorId) return 'horário pendente';

    const date = slot.date ? new Date(slot.date + 'T00:00:00').toLocaleDateString('pt-BR', {
        weekday: 'long',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
    }) : 'data pendente';

    const time = slot.time || 'horário pendente';
    const doctorName = slot.doctorName || 'profissional';

    // ✅ CORREÇÃO: "com a Dra." ao invés de "para você e a"
    return `${date} às ${time} com ${doctorName}`;
}

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

export function buildOrderedSlotOptions(slotsCtx = {}) {
    return [
        slotsCtx.primary,
        ...(slotsCtx.alternativesSamePeriod || []),
        ...(slotsCtx.alternativesOtherPeriod || []),
    ].filter(Boolean);
}