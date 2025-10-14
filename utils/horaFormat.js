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



function getDateRangeInUTC(dateString, timezoneOffsetHours = -3) {
    // Exemplo: dateString = '2025-08-07', timezoneOffsetHours = -3 (Brasília)

    // Criar data local "start of day"
    const localStart = new Date(`${dateString}T00:00:00`);
    // Ajustar para UTC subtraindo o offset (porque JS cria como local)
    const utcStart = new Date(localStart.getTime() - timezoneOffsetHours * 60 * 60 * 1000);

    // Mesmo para o fim do dia local
    const localEnd = new Date(`${dateString}T23:59:59.999`);
    const utcEnd = new Date(localEnd.getTime() - timezoneOffsetHours * 60 * 60 * 1000);

    return { utcStart, utcEnd };
}


/**
 * Verifica se uma data é fim de semana
 * @param {string|Date} date - Data no formato YYYY-MM-DD ou objeto Date
 * @returns {boolean} True se for fim de semana
 */
export const isWeekend = (date) => {
    // Converte string no formato YYYY-MM-DD para Date
    if (typeof date === 'string') {
        const [year, month, day] = date.split('-').map(Number);
        date = new Date(year, month - 1, day);
    }

    if (!(date instanceof Date) || isNaN(date.getTime())) {
        throw new Error('Data inválida');
    }

    const day = date.getDay();
    return day === 0 || day === 6; // 0 = Domingo, 6 = Sábado
};

/**
 * Retorna o próximo dia útil após a data fornecida
 * @param {string|Date} date - Data no formato YYYY-MM-DD ou objeto Date
 * @returns {Date} Objeto Date com o próximo dia útil
 */
export const nextBusinessDay = (date) => {
    // Converte string para Date se necessário
    if (typeof date === 'string') {
        const [year, month, day] = date.split('-').map(Number);
        date = new Date(year, month - 1, day);
    }

    if (!(date instanceof Date) || isNaN(date.getTime())) {
        throw new Error('Data inválida');
    }

    const newDate = new Date(date);
    do {
        newDate.setDate(newDate.getDate() + 1);
    } while (isWeekend(newDate));

    return newDate;
};
