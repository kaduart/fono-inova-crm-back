// Regras do PEI usadas pelas rotas e pelo relatório mensal. Ver docs/PEI.md.
import mongoose from 'mongoose';
import PeiPlan from '../../models/PeiPlan.js';

/** % do caminho entre linha de base e alvo (0–100). */
export function goalProgressPct(goal) {
    const base = Number(goal.baseline ?? 0);
    const target = Number(goal.target ?? 10);
    const cur = Number(goal.current ?? base);
    if (target <= base) return cur >= target ? 100 : 0;
    return Math.max(0, Math.min(100, Math.round(((cur - base) / (target - base)) * 100)));
}

/** Registra uma medição; marca como alcançada ao chegar no alvo (e volta para ativa se cair). */
export function applyProgress(goal, { value, note, by, date = new Date() }) {
    goal.history.push({ date, value, note, by });
    goal.current = value;
    if (goal.status !== 'paused') {
        if (value >= goal.target && goal.status !== 'achieved') { goal.status = 'achieved'; goal.achievedAt = date; }
        else if (value < goal.target && goal.status === 'achieved') { goal.status = 'active'; goal.achievedAt = undefined; }
    }
    return goal;
}

/** Metas do plano ativo, no formato que o relatório mensal guarda. */
export async function activeGoalsSnapshot({ patientId, doctorId }) {
    if (!mongoose.Types.ObjectId.isValid(String(patientId)) || !mongoose.Types.ObjectId.isValid(String(doctorId))) return [];
    const plan = await PeiPlan.findOne({ patient: patientId, doctor: doctorId, status: 'active' }).lean();
    if (!plan) return [];
    return (plan.goals || []).map(g => ({
        goalId: g._id, area: g.area, description: g.description, criterion: g.criterion || null,
        baseline: g.baseline, target: g.target, current: g.current ?? g.baseline, status: g.status,
        progressPct: goalProgressPct(g),
    }));
}
