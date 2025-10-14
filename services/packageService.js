import { isWeekend } from "../utils/horaFormat";

/**
 * Calcula as datas das sessões baseadas nos parâmetros fornecidos
 * @param {string} startDateStr - Data inicial no formato YYYY-MM-DD
 * @param {string} startTimeStr - Horário inicial no formato HH:mm
 * @param {number} totalSessions - Número total de sessões
 * @param {number} sessionsPerWeek - Sessões por semana
 * @param {boolean} [skipFirst=false] - Se true, pula a primeira sessão
 * @returns {Array} Array de objetos com {date: string, time: string}
 */
export const calculateSessionDates = (startDateStr, startTimeStr, count, sessionsPerWeek, skipFirst = false) => {
    if (count < 1) return [];

    const sessionDates = [];
    const [year, month, day] = startDateStr.split('-').map(Number);
    let currentDate = new Date(year, month - 1, day);

    // Validação da data
    if (isNaN(currentDate.getTime())) {
        throw new Error('Data inicial inválida');
    }

    // Se não for para pular a primeira, adiciona a data inicial
    if (!skipFirst) {
        sessionDates.push({
            date: startDateStr, // Mantém como string original
            time: startTimeStr
        });
    }

    // Calcula quantas sessões adicionais precisam ser criadas
    const additionalSessions = skipFirst ? count : count - 1;

    // Calcula o intervalo entre sessões em dias
    const daysBetween = Math.floor(7 / sessionsPerWeek);

    for (let i = 0; i < additionalSessions; i++) {
        // Avança a data
        currentDate.setDate(currentDate.getDate() + daysBetween);

        // Ajusta se for fim de semana
        while (isWeekend(currentDate)) {
            currentDate.setDate(currentDate.getDate() + 1);
        }

        // Formata para "YYYY-MM-DD"
        const formattedDate = [
            currentDate.getFullYear(),
            String(currentDate.getMonth() + 1).padStart(2, '0'),
            String(currentDate.getDate()).padStart(2, '0')
        ].join('-');

        sessionDates.push({
            date: formattedDate, // Garante formato string
            time: startTimeStr
        });
    }

    return sessionDates;
};

/**
 * Formata um objeto Date para string no formato YYYY-MM-DD
 * @param {Date} date - Objeto Date a ser formatado
 * @returns {string} Data formatada
 */
const formatDate = (date) => {
    if (!(date instanceof Date) || isNaN(date.getTime())) {
        throw new Error('Objeto Date inválido');
    }

    return [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0')
    ].join('-');
};