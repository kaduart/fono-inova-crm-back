// Função utilitária (coloque em um arquivo helpers.js)
export function extractTimeFromDateTime(datetimeString) {
    if (typeof datetimeString !== 'string') return '00:00';

    const timeMatch = datetimeString.match(/\d{2}:\d{2}/);
    return timeMatch ? timeMatch[0] : '00:00';
}

// utils/timeUtils.js
const BRASILIA_OFFSET = -3; // UTC-3

// Cria uma data no fuso horário de Brasília sem conversão automática
export const createBrasiliaDate = (dateString, timeString) => {
    const [year, month, day] = dateString?.split('-').map(Number);
    const [hours, minutes] = timeString?.split(':').map(Number);

    // Cria a data como se fosse UTC, mas ajustada para o offset de Brasília
    const utcDate = new Date(Date.UTC(year, month - 1, day, hours - BRASILIA_OFFSET, minutes));

    return utcDate;
};

// Formata a data para string ISO sem conversão de fuso
export const toLocalISOString = (date) => {
    const pad = (n) => n.toString().padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:00`;
};

// Extrai hora e minuto como string HH:mm
export const getTimeFromDate = (date) => {
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes}`;
};

export const parseDateTime = (dateTimeObj) => {
    if (!dateTimeObj || !dateTimeObj.date || !dateTimeObj.time) {
        throw new Error("Formato de data inválido. Esperado {date, time}");
    }

    const [year, month, day] = dateTimeObj.date.split('-').map(Number);
    const [hours, minutes] = dateTimeObj.time.split(':').map(Number);

    // Cria a data no fuso de Brasília
    return new Date(year, month - 1, day, hours, minutes);
};

export function convertToLocalTime(data) {
    if (Array.isArray(data)) {
        return data.map(convertToLocalTime);
    }

    if (data?.date instanceof Date) {
        const localDate = new Date(data.date);
        localDate.setHours(localDate.getHours() - 3); // UTC → GMT-3

        return {
            ...data,
            date: localDate,
            localTime: localDate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
        };
    }
    return data;
}

