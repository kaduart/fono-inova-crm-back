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

/**
 * Calcula as datas das sessões baseadas nos parâmetros fornecidos
 * @param {string} startDateStr - Data inicial no formato YYYY-MM-DD
 * @param {string} startTimeStr - Horário inicial no formato HH:mm
 * @param {number} totalSessions - Número total de sessões
 * @param {number} sessionsPerWeek - Sessões por semana
 * @returns {Array} Array de objetos com {date: string, time: string}
 */
export const calculateSessionDates = (startDateStr, startTimeStr, totalSessions, sessionsPerWeek) => {
    // Validação dos parâmetros
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDateStr)) {
        throw new Error('Formato de data inicial inválido. Use YYYY-MM-DD');
    }

    if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(startTimeStr)) {
        throw new Error('Formato de horário inválido. Use HH:mm');
    }

    const sessionDates = [];
    const [year, month, day] = startDateStr.split('-').map(Number);
    let currentDate = new Date(year, month - 1, day);

    // Valida data inicial
    if (isNaN(currentDate.getTime())) {
        throw new Error('Data inicial inválida');
    }

    // Ajusta se for fim de semana
    if (isWeekend(currentDate)) {
        currentDate = nextBusinessDay(currentDate);
    }

    // Adiciona a primeira sessão
    sessionDates.push({
        date: formatDate(currentDate),
        time: startTimeStr
    });

    // Calcula o intervalo entre sessões na mesma semana
    const daysBetweenSessions = Math.floor(5 / sessionsPerWeek);
    let sessionCount = 1;

    while (sessionDates.length < totalSessions) {
        const newDate = new Date(currentDate);

        // Avança semanas completas para sessões adicionais
        const weekOffset = Math.floor(sessionCount / sessionsPerWeek);

        // Calcula o dia dentro da semana
        const dayInWeek = sessionCount % sessionsPerWeek;

        // Calcula o deslocamento de dias
        const daysToAdd = weekOffset * 7 + dayInWeek * daysBetweenSessions;
        newDate.setDate(newDate.getDate() + daysToAdd);

        // Ajusta se for fim de semana
        if (isWeekend(newDate)) {
            const nextDate = nextBusinessDay(newDate);
            sessionDates.push({
                date: formatDate(nextDate),
                time: startTimeStr
            });
        } else {
            sessionDates.push({
                date: formatDate(newDate),
                time: startTimeStr
            });
        }

        sessionCount++;
    }

    return sessionDates.slice(0, totalSessions);
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