/**
 * Utilitário para verificar horário comercial
 * 
 * Configuração:
 * - Segunda a Sexta: 08:00 - 18:00
 * - Sábado: 08:00 - 12:00
 * - Domingo: Fechado
 */

const BUSINESS_HOURS = {
  // 0 = Domingo, 1 = Segunda, ..., 6 = Sábado
  0: null, // Fechado
  1: { start: '08:00', end: '18:00' },
  2: { start: '08:00', end: '18:00' },
  3: { start: '08:00', end: '18:00' },
  4: { start: '08:00', end: '18:00' },
  5: { start: '08:00', end: '18:00' },
  6: { start: '08:00', end: '12:00' }
};

/**
 * Verifica se está dentro do horário comercial
 * @param {Date} date - Data/hora a verificar (default: now)
 * @returns {boolean}
 */
export function isBusinessHours(date = new Date()) {
  const day = date.getDay(); // 0-6
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const currentTime = hours * 60 + minutes; // Em minutos desde meia-noite

  const schedule = BUSINESS_HOURS[day];
  
  // Se não tem horário definido (domingo), está fechado
  if (!schedule) return false;

  // Converte horários para minutos
  const [startHour, startMin] = schedule.start.split(':').map(Number);
  const [endHour, endMin] = schedule.end.split(':').map(Number);
  
  const startMinutes = startHour * 60 + startMin;
  const endMinutes = endHour * 60 + endMin;

  return currentTime >= startMinutes && currentTime <= endMinutes;
}

/**
 * Verifica se está fora do horário comercial
 * @param {Date} date - Data/hora a verificar (default: now)
 * @returns {boolean}
 */
export function isAfterHours(date = new Date()) {
  return !isBusinessHours(date);
}

/**
 * Retorna informações sobre o próximo horário comercial
 * @param {Date} date - Data/hora de referência (default: now)
 * @returns {Object}
 */
export function getNextBusinessHours(date = new Date()) {
  const currentDay = date.getDay();
  const currentTime = date.getHours() * 60 + date.getMinutes();

  // Se estamos em horário comercial, retorna o atual
  if (isBusinessHours(date)) {
    const schedule = BUSINESS_HOURS[currentDay];
    return {
      isOpen: true,
      day: currentDay,
      start: schedule.start,
      end: schedule.end,
      message: 'Horário comercial em andamento'
    };
  }

  // Procura o próximo dia útil
  let daysToAdd = 0;
  let nextDay = currentDay;

  do {
    daysToAdd++;
    nextDay = (currentDay + daysToAdd) % 7;
  } while (!BUSINESS_HOURS[nextDay] && daysToAdd < 7);

  const nextSchedule = BUSINESS_HOURS[nextDay];
  const nextDate = new Date(date);
  nextDate.setDate(date.getDate() + daysToAdd);

  const dayNames = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

  return {
    isOpen: false,
    nextOpenDay: nextDay,
    nextOpenDayName: dayNames[nextDay],
    nextOpenDate: nextDate.toISOString().split('T')[0],
    start: nextSchedule?.start,
    end: nextSchedule?.end,
    message: `Próximo horário comercial: ${dayNames[nextDay]} às ${nextSchedule?.start}`
  };
}

/**
 * Middleware Express para verificar horário comercial
 * Adiciona req.isBusinessHours à requisição
 */
export function businessHoursMiddleware(req, res, next) {
  req.isBusinessHours = isBusinessHours();
  req.businessHoursInfo = getNextBusinessHours();
  next();
}

/**
 * Formata horário para exibição amigável
 * @param {Date} date - Data
 * @returns {string}
 */
export function formatBusinessStatus(date = new Date()) {
  if (isBusinessHours(date)) {
    return '🟢 Horário comercial';
  }
  
  const next = getNextBusinessHours(date);
  return `🔴 Fora do horário - ${next.message}`;
}

// Exporta configuração para possível customização
export { BUSINESS_HOURS };
