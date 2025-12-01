// ============================================================================
// 🤖 AMANDA AUTO-BOOKING - VERSÃO SIMPLIFICADA (SÓ CHAMA ROTAS EXISTENTES)
// ============================================================================
// Arquivo: services/amandaBookingService.js

import axios from 'axios';
import Doctor from '../models/Doctor.js';

const API_BASE = process.env.BACKEND_URL_PRD || 'http://localhost:5000';
const ADMIN_TOKEN = process.env.ADMIN_API_TOKEN;

const bookingStats = {
    totalAttempts: 0,
    successful: 0,
    conflicts: 0,
    errors: 0
};
// ============================================================================
// 🔍 PASSO 1: BUSCAR SLOTS DISPONÍVEIS
// ============================================================================

/**
 * Encontra os melhores horários disponíveis para uma área de terapia
 */
export async function findAvailableSlots({
    therapyArea,
    preferredDay = null,
    preferredPeriod = null,
    daysAhead = 5,
}) {
    try {
        console.log('🔍 [BOOKING] Buscando slots:', { therapyArea, preferredPeriod });

        if (!therapyArea) {
            console.warn('⚠️ [BOOKING] therapyArea não informada');
            return null;
        }

        // 👉 No banco: specialty = 'fonoaudiologia', 'psicologia' etc (minúsculo)
        // 👉 No banco: active: true (não isActive)
        const doctors = await Doctor.find({
            specialty: therapyArea,   // ex: 'fonoaudiologia'
            role: 'doctor',
            $or: [
                { active: true },    // principal
                { isActive: true },  // compatibilidade se existir
                {
                    active: { $exists: false },
                    isActive: { $exists: false }
                }
            ]
        })
            .select('_id fullName specialty weeklyAvailability')
            .lean();

        if (!doctors.length) {
            console.warn('⚠️ [BOOKING] Nenhum profissional encontrado para', therapyArea);
            return null;
        }

        // Data de partida (hoje ou “segunda / terça / amanhã”)
        const startDateObj = preferredDay
            ? parseDateFromUserInput(preferredDay)
            : (() => {
                const d = new Date();
                d.setHours(0, 0, 0, 0);
                return d;
            })();

        // Gera array de strings YYYY-MM-DD
        const dateStrings = [];
        for (let i = 0; i < daysAhead; i++) {
            const d = new Date(startDateObj);
            d.setDate(startDateObj.getDate() + i);
            const dateStr = d.toISOString().split('T')[0];
            dateStrings.push(dateStr);
        }

        // Chama /api/appointments/available-slots pra cada (doctor, data)
        const tasks = [];

        for (const doctor of doctors) {
            for (const dateStr of dateStrings) {
                tasks.push(
                    callAvailableSlotsAPI(doctor._id, dateStr)
                        .then((slots) => ({
                            doctor,
                            dateStr,
                            slots: Array.isArray(slots) ? slots : [],
                        }))
                        .catch((err) => {
                            console.warn(
                                `⚠️ [BOOKING] Erro slots (${doctor._id}, ${dateStr}):`,
                                err.message
                            );
                            return { doctor, dateStr, slots: [] };
                        })
                );
            }
        }

        const results = await Promise.all(tasks);

        const allSlots = [];

        for (const { doctor, dateStr, slots } of results) {
            if (!slots || !slots.length) continue;

            const filteredSlots = preferredPeriod
                ? filterSlotsByPeriod(slots, preferredPeriod) // slots = ["14:00", ...]
                : slots;

            for (const time of filteredSlots) {
                allSlots.push({
                    doctorId: doctor._id,
                    doctorName: doctor.fullName || doctor.name || 'Profissional',
                    specialty: doctor.specialty,
                    date: dateStr,               // "2025-12-01"
                    time,                        // "14:00"
                    period: getTimePeriod(time), // "manhã" / "tarde"
                });
            }
        }

        if (!allSlots.length) {
            console.log('ℹ️ [BOOKING] Nenhum slot disponível encontrado');
            return null;
        }

        // Ordena por data + hora
        allSlots.sort((a, b) => {
            if (a.date !== b.date) {
                return a.date.localeCompare(b.date);
            }
            return a.time.localeCompare(b.time);
        });

        const primary = allSlots[0];
        const samePeriod = allSlots
            .filter(
                (s) =>
                    s.period === primary.period &&
                    (s.date !== primary.date || s.time !== primary.time)
            )
            .slice(0, 3);

        const otherPeriod = allSlots
            .filter((s) => s.period !== primary.period)
            .slice(0, 2);

        console.log('✅ [BOOKING] Slots encontrados:', {
            total: allSlots.length,
            primary,
        });

        return {
            primary,
            alternativesSamePeriod: samePeriod,
            alternativesOtherPeriod: otherPeriod,
            totalFound: allSlots.length,
        };
    } catch (error) {
        console.error('❌ [BOOKING] Erro ao buscar slots:', error.message);
        return null;
    }
}

// ============================================================================
// 📅 PASSO 2 + 3: CRIAR PACIENTE + AGENDAR (FLUXO COMPLETO)
// ============================================================================

/**
 * 🎯 FUNÇÃO PRINCIPAL - Apenas chama suas rotas existentes
 * 
 * 1) POST /api/patients/add → pega patientId
 * 2) POST /api/appointments → cria tudo (pagamento + sessão + appointment)
 */
export async function autoBookAppointment({
    lead,
    chosenSlot,
    patientInfo // { fullName, birthDate, phone, email }
}) {
    bookingStats.totalAttempts++;
    try {
        console.log('🎯 [AUTO-BOOKING] Iniciando fluxo completo');

        const { fullName, birthDate, phone, email } = patientInfo;

        // ====================================================================
        // 1️⃣ CHAMA SUA ROTA: POST /api/patients/add
        // ====================================================================
        console.log('👤 [BOOKING] Criando/buscando paciente...');

        let patientId = null;

        try {
            const patientResponse = await axios.post(
                `${API_BASE}/api/patients/add`,
                {
                    fullName,
                    dateOfBirth: birthDate,
                    phone,
                    email: email || undefined
                },
                {
                    headers: {
                        'Authorization': `Bearer ${ADMIN_TOKEN}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 8000
                }
            );

            if (patientResponse.data.success) {
                patientId = patientResponse.data.data._id;
                console.log('✅ [BOOKING] Paciente criado:', patientId);
            }


        } catch (patientError) {
            // Se retornar 409 (duplicado), pega o ID existente
            if (patientError.response?.status === 409) {
                patientId = patientError.response.data.existingId;

                if (patientId) {
                    console.log('✅ [BOOKING] Paciente já existe:', patientId);
                } else {
                    throw new Error('Paciente duplicado mas sem ID retornado');
                }
            } else {
                throw patientError;
            }
        }

        if (!patientId) {
            throw new Error('Não foi possível criar/encontrar o paciente');
        }

        // ====================================================================
        // 2️⃣ CHAMA SUA ROTA: POST /api/appointments
        // Ela já cria: Payment + Session + Appointment automaticamente!
        // ====================================================================
        console.log('📅 [BOOKING] Criando agendamento...');

        const appointmentResponse = await axios.post(
            `${API_BASE}/api/appointments`,
            {
                patientId,
                doctorId: chosenSlot.doctorId,
                specialty: chosenSlot.specialty,
                date: chosenSlot.date,   // ✅ string
                time: chosenSlot.time,   // ✅ string
                serviceType: 'individual_session',
                sessionType: 'avaliacao',
                paymentMethod: 'to_define',
                paymentAmount: 0,
                status: 'scheduled',
                notes: '[AGENDADO AUTOMATICAMENTE VIA AMANDA/WHATSAPP]',
                isAdvancePayment: false,
            },
            {
                headers: {
                    Authorization: `Bearer ${ADMIN_TOKEN}`,
                    'Content-Type': 'application/json',
                },
                timeout: 8000,
            }
        );

        if (!appointmentResponse.data.success) {
            bookingStats.errors++;
            throw new Error(appointmentResponse.data.message || 'Erro desconhecido');
        }

        const appointmentData = appointmentResponse.data.data;

        console.log('✅ [BOOKING] Agendamento criado com sucesso!', {
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
        console.error('❌ [AUTO-BOOKING] Erro:', error.message);

        const isConflict =
            error.response?.status === 409 ||
            /conflito|conflict|occupied|preenchido/i.test(
                error.response?.data?.message || error.message
            );

        if (isConflict) {
            bookingStats.conflicts++;
            return {
                success: false,
                code: 'TIME_CONFLICT',
                error: 'Horário não está mais disponível',
            };
        }

        bookingStats.errors++;
        return {
            success: false,
            error: error.response?.data?.message || error.message,
        };
    }
}


// ============================================================================
// 🛠️ FUNÇÕES AUXILIARES
// ============================================================================

/**
 * Chama sua rota GET /api/appointments/available-slots
 */
async function callAvailableSlotsAPI(doctorId, date) {
    try {
        const response = await axios.get(
            `${API_BASE}/api/appointments/available-slots`,
            {
                params: { doctorId, date },
                headers: {
                    'Authorization': `Bearer ${ADMIN_TOKEN}`
                },
                timeout: 5000
            }
        );

        // Sua rota pode retornar:
        // - Array direto: ["09:00", "10:00"]
        // - Objeto: { availableSlots: ["09:00", "10:00"] }
        if (Array.isArray(response.data)) {
            return response.data;
        }

        if (response.data.availableSlots) {
            return response.data.availableSlots;
        }

        return [];

    } catch (error) {
        console.warn(`⚠️ Erro ao buscar slots (${doctorId}, ${date}):`, error.message);
        return [];
    }
}

/**
 * Filtra horários por período
 */
function filterSlotsByPeriod(slots, period) {
    const normalized = period.toLowerCase();

    return slots.filter(time => {
        const hour = parseInt(time.split(':')[0]);

        if (normalized.includes('manh') || normalized.includes('cedo')) {
            return hour >= 7 && hour < 12;
        }
        if (normalized.includes('tard')) {
            return hour >= 12 && hour < 18;
        }

        return true;
    });
}

/**
 * Determina se é manhã ou tarde
 */
function getTimePeriod(time) {
    const hour = parseInt(time.split(':')[0]);
    return hour < 12 ? 'manhã' : 'tarde';
}

/**
 * Extrai data de texto do usuário
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
        'domingo': 0, 'segunda': 1, 'terça': 2, 'terca': 2,
        'quarta': 3, 'quinta': 4, 'sexta': 5, 'sábado': 6, 'sabado': 6
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
 * Formata data para PT-BR
 */
export function formatDatePtBr(dateStr) {
    const [year, month, day] = dateStr.split('-');
    return `${day}/${month}/${year}`;
}

/**
 * Extrai slot escolhido da mensagem do usuário
 */
export function pickSlotFromUserReply(text, availableSlots) {
    if (!availableSlots?.primary) return null;

    const normalized = text.toLowerCase();

    // "primeiro", "1", "opção 1"
    if (/\b(primeiro|1|op[çc][aã]o\s*1)\b/.test(normalized)) {
        return availableSlots.primary;
    }

    // "segundo", "2"
    if (/\b(segundo|2|op[çc][aã]o\s*2)\b/.test(normalized) &&
        availableSlots.alternativesSamePeriod?.[0]) {
        return availableSlots.alternativesSamePeriod[0];
    }

    // "terceiro", "3"
    if (/\b(terceiro|3|op[çc][aã]o\s*3)\b/.test(normalized) &&
        availableSlots.alternativesSamePeriod?.[1]) {
        return availableSlots.alternativesSamePeriod[1];
    }

    // Tenta extrair dia + horário específico
    const weekdayMatch = normalized.match(/\b(segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo)\b/);
    const timeMatch = normalized.match(/\b(\d{1,2})[h:]\s*(\d{2})?\b/);

    if (weekdayMatch && timeMatch) {
        const targetDay = weekdayMatch[1];
        const targetHour = timeMatch[1].padStart(2, '0');
        const targetMin = timeMatch[2] || '00';
        const targetTime = `${targetHour}:${targetMin}`;

        const allSlots = [
            availableSlots.primary,
            ...(availableSlots.alternativesSamePeriod || []),
            ...(availableSlots.alternativesOtherPeriod || [])
        ];

        for (const slot of allSlots) {
            const slotDate = new Date(slot.date + 'T12:00:00-03:00');
            const slotDay = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'][slotDate.getDay()];

            if (slotDay === targetDay && slot.time.startsWith(targetTime)) {
                return slot;
            }
        }
    }

    // Fallback: retorna o primeiro
    return availableSlots.primary;
}

/**
 * Formata slot para exibição
 */
export function formatSlot(slot) {
    const date = formatDatePtBr(slot.date);
    const time = slot.time.slice(0, 5);
    const weekday = new Date(slot.date + 'T12:00:00-03:00')
        .toLocaleDateString('pt-BR', { weekday: 'long' });

    return `${weekday.charAt(0).toUpperCase() + weekday.slice(1)}, ${date} às ${time} - ${slot.doctorName}`;
}