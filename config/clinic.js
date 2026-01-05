// config/clinic.js
import dotenv from 'dotenv';
dotenv.config();

/**
 * Configurações centralizadas da clínica
 */

// Recesso de fim de ano
export const RECESSO = {
    start: process.env.RECESSO_START
        ? new Date(process.env.RECESSO_START)
        : new Date('2025-12-19'),
    end: process.env.RECESSO_END
        ? new Date(process.env.RECESSO_END)
        : new Date('2026-01-05'),
};

// Verifica se uma data está no período de recesso
export function isInRecesso(date = new Date()) {
    const d = new Date(date);
    return d >= RECESSO.start && d <= RECESSO.end;
}

// Retorna primeira data disponível após recesso
export function getFirstAvailableDate() {
    const today = new Date();
    if (isInRecesso(today)) {
        const firstDay = new Date(RECESSO.end);
        firstDay.setDate(firstDay.getDate() + 1);
        return firstDay;
    }
    return today;
}

// Endereço da clínica
export const CLINIC_ADDRESS = "Av. Minas Gerais, 405 - Bairro Jundiaí, Anápolis - GO, 75110-770, Brasil";

// Horários de funcionamento
export const BUSINESS_HOURS = {
    start: 8,  // 8h
    end: 18,   // 18h
    lunch: { start: 12, end: 13 }
};

// Limites do sistema
export const LIMITS = {
    maxFollowupsPerLead: 3,
    followupIntervalHours: {
        first: 2,
        second: 48,
        third: 72
    }
};

export default {
    RECESSO,
    isInRecesso,
    getFirstAvailableDate,
    CLINIC_ADDRESS,
    BUSINESS_HOURS,
    LIMITS
};