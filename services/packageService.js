export const isWeekend = (date) => {
    const day = date.getDay();
    return day === 0 || day === 6; // 0 = Domingo, 6 = Sábado
};

// Função para avançar para o próximo dia útil
export const nextBusinessDay = (date) => {
    const newDate = new Date(date);
    do {
        newDate.setDate(newDate.getDate() + 1);
    } while (isWeekend(newDate));
    return newDate;
};

// Função para calcular datas das sessões com distribuição correta
export const calculateSessionDates = (startDate, totalSessions, sessionsPerWeek) => {
    const sessionDates = [];
    const date = new Date(startDate);

    // Garante que a data inicial não é fim de semana
    if (isWeekend(date)) {
        date = nextBusinessDay(date);
    }

    sessionDates.push(new Date(date));

    // Calcula o intervalo entre sessões na mesma semana
    const daysBetweenSessions = Math.floor(5 / sessionsPerWeek);
    let sessionCount = 1;
    let weekOffset = 0;

    while (sessionDates.length < totalSessions) {
        const newDate = new Date(startDate);

        // Avança semanas completas para sessões adicionais
        weekOffset = Math.floor(sessionCount / sessionsPerWeek);

        // Calcula o dia dentro da semana
        const dayInWeek = sessionCount % sessionsPerWeek;

        // Calcula o deslocamento de dias
        const daysToAdd = weekOffset * 7 + dayInWeek * daysBetweenSessions;

        newDate.setDate(newDate.getDate() + daysToAdd);

        // Se cair no fim de semana, ajusta para segunda-feira
        if (isWeekend(newDate)) {
            newDate.setDate(newDate.getDate() + (8 - newDate.getDay()) % 7);
        }

        sessionDates.push(newDate);
        sessionCount++;
    }

    return sessionDates.slice(0, totalSessions);
};