// services/planningAutoService.js
// Automação de planejamentos mensal → semanal → diário com base em dias úteis

import Planning from '../models/Planning.js';
import { isNationalHoliday } from '../config/feriadosBR.js';

const pad = (n) => String(n).padStart(2, '0');
const toLocalDate = (dateStr) => {
  // Interpreta a string YYYY-MM-DD no timezone de Brasília, igual ao restante do sistema
  return new Date(dateStr + 'T00:00:00-03:00');
};

const formatDate = (date) => {
  const d = typeof date === 'string' ? toLocalDate(date) : new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const isWeekday = (date) => {
  const d = typeof date === 'string' ? toLocalDate(date) : new Date(date);
  const day = d.getDay();
  return day >= 1 && day <= 5; // segunda a sexta
};

const isWorkingDay = (date) => isWeekday(date) && !isNationalHoliday(date);

const getMonthBounds = (year, month) => {
  const start = `${year}-${pad(month)}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const end = `${year}-${pad(month)}-${pad(lastDay)}`;
  return { start, end, lastDay };
};

export const getMonthWorkingDays = (year, month) => {
  const { start, end } = getMonthBounds(year, month);
  const days = [];
  const cur = toLocalDate(start);
  const endDate = toLocalDate(end);
  while (cur <= endDate) {
    const dateStr = formatDate(cur);
    if (isWorkingDay(dateStr)) {
      days.push(dateStr);
    }
    cur.setDate(cur.getDate() + 1);
  }
  return days;
};

export const getWeeksOfMonth = (year, month) => {
  const { lastDay } = getMonthBounds(year, month);
  const base = `${year}-${pad(month)}`;
  return [
    { start: `${base}-01`, end: `${base}-07` },
    { start: `${base}-08`, end: `${base}-14` },
    { start: `${base}-15`, end: `${base}-21` },
    { start: `${base}-22`, end: `${base}-${pad(lastDay)}` }
  ];
};

const countWorkingDaysInRange = (start, end) => {
  let count = 0;
  const cur = toLocalDate(start);
  const endDate = toLocalDate(end);
  while (cur <= endDate) {
    if (isWorkingDay(formatDate(cur))) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
};

const distributeWithRemainder = (total, count, decimals = 2) => {
  if (count <= 0) return [];
  const base = Math.floor((total / count) * Math.pow(10, decimals)) / Math.pow(10, decimals);
  const values = Array(count).fill(base);
  const currentSum = values.reduce((a, b) => a + b, 0);
  const remainder = Math.round((total - currentSum) * Math.pow(10, decimals)) / Math.pow(10, decimals);
  if (remainder !== 0) {
    values[values.length - 1] = Math.round((values[values.length - 1] + remainder) * Math.pow(10, decimals)) / Math.pow(10, decimals);
  }
  return values;
};

const normalizeBySpecialty = (bySpecialty = []) => {
  return bySpecialty.map(s => ({
    specialty: s.specialty,
    targetSessions: Number(s.sessions || s.targetSessions || 0),
    completedSessions: 0
  }));
};

/**
 * Gera/Substitui planejamento mensal e cria semanais + diários proporcionais aos dias úteis.
 */
export const generateMonthlyCascade = async (month, year, targets, userId, options = {}) => {
  const { notes = '', bySpecialty = [], force = false } = options;
  const { start, end } = getMonthBounds(year, month);

  const monthlyTargets = {
    expectedRevenue: Number(targets.expectedRevenue || 0),
    totalSessions: Number(targets.totalSessions || 0),
    workHours: Number(targets.workHours || 0),
    averageTicket: Number(targets.averageTicket || 0),
    commercialTicket: Number(targets.commercialTicket || 0),
    availableSlots: Number(targets.totalSessions || 0)
  };

  // Criar ou atualizar planejamento mensal
  let monthly = await Planning.findOne({ type: 'monthly', 'period.start': start, 'period.end': end });
  if (monthly && !force) {
    monthly.targets = { ...monthlyTargets };
    monthly.notes = notes;
    monthly.bySpecialty = normalizeBySpecialty(bySpecialty);
    await monthly.save();
  } else {
    monthly = await Planning.create({
      type: 'monthly',
      period: { start, end },
      targets: monthlyTargets,
      notes,
      bySpecialty: normalizeBySpecialty(bySpecialty),
      createdBy: userId
    });
  }

  // Remover semanais/diários existentes para evitar duplicatas
  await Planning.deleteMany({
    type: { $in: ['weekly', 'daily'] },
    'period.start': { $gte: start },
    'period.end': { $lte: end }
  });

  const workingDays = getMonthWorkingDays(year, month);
  const totalWorkingDays = workingDays.length;

  // Criar diários
  const dailyRevenues = distributeWithRemainder(monthlyTargets.expectedRevenue, totalWorkingDays, 2);
  const dailySessions = distributeWithRemainder(monthlyTargets.totalSessions, totalWorkingDays, 0);
  const dailyHours = distributeWithRemainder(monthlyTargets.workHours, totalWorkingDays, 1);

  const dailyPlannings = await Promise.all(
    workingDays.map((dateStr, idx) =>
      Planning.create({
        type: 'daily',
        period: { start: dateStr, end: dateStr },
        targets: {
          expectedRevenue: dailyRevenues[idx],
          totalSessions: dailySessions[idx],
          workHours: dailyHours[idx],
          averageTicket: monthlyTargets.averageTicket,
          commercialTicket: monthlyTargets.commercialTicket,
          availableSlots: dailySessions[idx]
        },
        notes: notes ? `${notes} (diário)` : '',
        createdBy: userId
      })
    )
  );

  // Criar semanais proporcionais aos dias úteis de cada semana
  const weeks = getWeeksOfMonth(year, month);
  const weeklyPlannings = [];
  for (const week of weeks) {
    const weekWorkingDays = countWorkingDaysInRange(week.start, week.end);
    if (weekWorkingDays === 0) {
      weeklyPlannings.push(
        await Planning.create({
          type: 'weekly',
          period: { start: week.start, end: week.end },
          targets: {
            expectedRevenue: 0,
            totalSessions: 0,
            workHours: 0,
            averageTicket: monthlyTargets.averageTicket,
            commercialTicket: monthlyTargets.commercialTicket,
            availableSlots: 0
          },
          notes: notes ? `${notes} (semanal)` : '',
          createdBy: userId
        })
      );
      continue;
    }

    const frac = weekWorkingDays / totalWorkingDays;
    weeklyPlannings.push(
      await Planning.create({
        type: 'weekly',
        period: { start: week.start, end: week.end },
        targets: {
          expectedRevenue: Math.round(monthlyTargets.expectedRevenue * frac * 100) / 100,
          totalSessions: Math.round(monthlyTargets.totalSessions * frac),
          workHours: parseFloat((monthlyTargets.workHours * frac).toFixed(1)),
          averageTicket: monthlyTargets.averageTicket,
          commercialTicket: monthlyTargets.commercialTicket,
          availableSlots: Math.round(monthlyTargets.totalSessions * frac)
        },
        notes: notes ? `${notes} (semanal)` : '',
        createdBy: userId
      })
    );
  }

  // Ajustar última semana para absorver arredondamento e garantir soma exata
  const weeklySum = weeklyPlannings.reduce((sum, p) => sum + p.targets.expectedRevenue, 0);
  const weeklyDiff = Math.round((monthlyTargets.expectedRevenue - weeklySum) * 100) / 100;
  if (weeklyDiff !== 0 && weeklyPlannings.length > 0) {
    const last = weeklyPlannings[weeklyPlannings.length - 1];
    last.targets.expectedRevenue = Math.round((last.targets.expectedRevenue + weeklyDiff) * 100) / 100;
    await last.save();
  }

  return {
    monthly,
    weekly: weeklyPlannings,
    daily: dailyPlannings,
    workingDays
  };
};

/**
 * Recalcula metas de dias/semanas futuras com base no gap real do mensal.
 */
export const recalculateFutureTargets = async (month, year) => {
  const { start, end } = getMonthBounds(year, month);
  const monthly = await Planning.findOne({ type: 'monthly', 'period.start': start, 'period.end': end });
  if (!monthly) throw new Error('Planejamento mensal não encontrado');

  const todayStr = formatDate(new Date());
  const dailyPlannings = await Planning.find({
    type: 'daily',
    'period.start': { $gte: start, $lte: end }
  }).sort({ 'period.start': 1 });

  const futureDailies = dailyPlannings.filter(d => d.period.start >= todayStr);
  const pastDailies = dailyPlannings.filter(d => d.period.start < todayStr);

  const realizedRevenue = pastDailies.reduce((sum, d) => sum + (d.actual?.actualRevenue || 0), 0);
  const gapRevenue = Math.max(0, monthly.targets.expectedRevenue - realizedRevenue);

  const futureWorkingDays = futureDailies.length;
  if (futureWorkingDays === 0) return { monthly, updated: [] };

  const futureRevenues = distributeWithRemainder(gapRevenue, futureWorkingDays, 2);
  const futureSessions = distributeWithRemainder(
    Math.max(0, monthly.targets.totalSessions - pastDailies.reduce((s, d) => s + (d.actual?.completedSessions || 0), 0)),
    futureWorkingDays,
    0
  );
  const futureHours = distributeWithRemainder(
    Math.max(0, monthly.targets.workHours - pastDailies.reduce((s, d) => s + (d.actual?.workedHours || 0), 0)),
    futureWorkingDays,
    1
  );

  const updated = [];
  for (let i = 0; i < futureDailies.length; i++) {
    const planning = futureDailies[i];
    planning.targets.expectedRevenue = futureRevenues[i];
    planning.targets.totalSessions = futureSessions[i];
    planning.targets.workHours = futureHours[i];
    planning.targets.availableSlots = futureSessions[i];
    await planning.save();
    updated.push(planning);
  }

  // Recalcular semanais futuras como soma dos diários daquela semana
  const weeklyPlannings = await Planning.find({
    type: 'weekly',
    'period.start': { $gte: start, $lte: end }
  });

  for (const week of weeklyPlannings) {
    if (week.period.end < todayStr) continue; // passado não muda
    const dailiesInWeek = dailyPlannings.filter(
      d => d.period.start >= week.period.start && d.period.end <= week.period.end
    );
    week.targets.expectedRevenue = Math.round(
      dailiesInWeek.reduce((sum, d) => sum + d.targets.expectedRevenue, 0) * 100
    ) / 100;
    week.targets.totalSessions = dailiesInWeek.reduce((sum, d) => sum + d.targets.totalSessions, 0);
    week.targets.workHours = parseFloat(
      dailiesInWeek.reduce((sum, d) => sum + d.targets.workHours, 0).toFixed(1)
    );
    week.targets.availableSlots = week.targets.totalSessions;
    await week.save();
  }

  return { monthly, updated };
};

export default {
  generateMonthlyCascade,
  recalculateFutureTargets,
  getMonthWorkingDays,
  getWeeksOfMonth
};
