// Cálculo do relatório mensal. Só evoluções finalizadas entram (FINALIZED_FILTER).
import mongoose from 'mongoose';
import Evolution, { FINALIZED_FILTER } from '../../models/Evolution.js';
import Appointment from '../../models/Appointment.js';

export const monthRange = (month) => {
    const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
    if (!m) return null;
    const start = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
    const end = new Date(Date.UTC(Number(m[1]), Number(m[2]), 1));
    return { start, end };
};

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Áreas: primeira e última nota do mês por área (pela data da evolução).
 * Função pura para teste.
 */
export function summarizeAreas(evolutions) {
    const byArea = new Map();
    const sorted = [...evolutions].sort((a, b) => new Date(a.date) - new Date(b.date));
    for (const evo of sorted) {
        for (const a of evo.evaluationAreas || []) {
            const name = String(a?.name || '').trim();
            if (!name || typeof a.score !== 'number') continue;
            const cur = byArea.get(name) || { name, first: a.score, last: a.score, sessions: 0 };
            cur.last = a.score;
            cur.sessions += 1;
            byArea.set(name, cur);
        }
    }
    return [...byArea.values()]
        .map(a => ({ ...a, delta: round1(a.last - a.first) }))
        .sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name));
}

const ATTENDED = ['completed', 'paid'];
const MISSED = ['missed'];
const CANCELED = ['canceled'];

export function summarizeAttendance(appointments) {
    const out = { attended: 0, missed: 0, canceled: 0 };
    for (const ap of appointments) {
        if (ATTENDED.includes(ap.operationalStatus)) out.attended += 1;
        else if (MISSED.includes(ap.operationalStatus)) out.missed += 1;
        else if (CANCELED.includes(ap.operationalStatus)) out.canceled += 1;
    }
    const base = out.attended + out.missed;
    out.rate = base ? Math.round((out.attended / base) * 100) : null;
    return out;
}

/** Monta a fotografia do mês. `goals` (PEI) é opcional. */
export async function buildMonthlyData({ patientId, doctorId, month, goals = [] }) {
    const range = monthRange(month);
    if (!range) throw new Error('Mês inválido (use AAAA-MM)');
    const patient = new mongoose.Types.ObjectId(String(patientId));
    const doctor = new mongoose.Types.ObjectId(String(doctorId));
    const [evolutions, appointments] = await Promise.all([
        Evolution.find({ patient, doctor, date: { $gte: range.start, $lt: range.end }, ...FINALIZED_FILTER })
            .select('date evaluationAreas specialty treatmentStatus').lean(),
        Appointment.find({ patient, doctor, date: { $gte: range.start, $lt: range.end } })
            .select('operationalStatus date').lean(),
    ]);
    const last = [...evolutions].sort((a, b) => new Date(b.date) - new Date(a.date))[0];
    return {
        sessionsWithEvolution: evolutions.length,
        attendance: summarizeAttendance(appointments),
        areas: summarizeAreas(evolutions),
        treatmentStatus: last?.treatmentStatus || null,
        specialty: last?.specialty || null,
        goals,
    };
}
