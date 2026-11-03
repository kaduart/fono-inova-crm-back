// PEI (item 5) — /api/v2/pei. Ver docs/PEI.md.
// Profissional mexe só nos próprios planos; admin vê e mexe em todos. Secretária não acessa.
import express from 'express';
import mongoose from 'mongoose';
import PeiPlan from '../models/PeiPlan.js';
import { flexibleAuth } from '../middleware/amandaAuth.js';
import { applyProgress, goalProgressPct } from '../services/clinical/peiService.js';

const router = express.Router();
const isAdmin = (user) => ['admin', 'superadmin'].includes(String(user?.role || '').toLowerCase());
const isClinical = (user) => isAdmin(user) || String(user?.role || '').toLowerCase() === 'doctor';
const ok = (data, meta = {}) => ({ success: true, data, meta: { version: 'v2', timestamp: new Date().toISOString(), ...meta } });
const fail = (code, message) => ({ success: false, error: { code, message }, message });
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ''));
const num = (v) => (v === '' || v == null ? undefined : Number(v));
const validScore = (v) => v === undefined || (Number.isFinite(v) && v >= 0 && v <= 10);

const withProgress = (plan) => {
    const p = typeof plan.toObject === 'function' ? plan.toObject() : plan;
    return { ...p, goals: (p.goals || []).map(g => ({ ...g, progressPct: goalProgressPct(g) })) };
};

function cleanGoal(raw = {}) {
    const g = {
        area: String(raw.area || '').trim(),
        description: String(raw.description || '').trim(),
        criterion: raw.criterion ? String(raw.criterion).trim() : undefined,
        baseline: num(raw.baseline) ?? 0,
        target: num(raw.target) ?? 10,
    };
    if (!g.area || !g.description) return { error: 'Cada meta precisa de área e descrição.' };
    if (!validScore(g.baseline) || !validScore(g.target)) return { error: 'Linha de base e alvo vão de 0 a 10.' };
    if (g.target <= g.baseline) return { error: `O alvo precisa ser maior que a linha de base (meta "${g.description.slice(0, 40)}").` };
    return { goal: g };
}

router.use(flexibleAuth, (req, res, next) => {
    if (!isClinical(req.user)) return res.status(403).json(fail('FORBIDDEN', 'O PEI é da equipe clínica.'));
    next();
});

async function loadOwned(req, res) {
    if (!isId(req.params.id)) { res.status(400).json(fail('INVALID_ID', 'ID inválido')); return null; }
    const plan = await PeiPlan.findById(req.params.id);
    if (!plan) { res.status(404).json(fail('NOT_FOUND', 'PEI não encontrado')); return null; }
    if (!isAdmin(req.user) && String(plan.doctor) !== String(req.user?.id)) {
        res.status(403).json(fail('FORBIDDEN', 'Só o profissional do PEI pode mexer nele')); return null;
    }
    return plan;
}

router.get('/patient/:patientId', async (req, res) => {
    try {
        if (!isId(req.params.patientId)) return res.status(400).json(fail('INVALID_ID', 'Paciente inválido'));
        const filter = { patient: req.params.patientId };
        if (!isAdmin(req.user)) filter.doctor = req.user.id;
        const plans = await PeiPlan.find(filter).sort({ status: 1, startDate: -1 }).limit(20).populate('doctor', 'fullName specialty').lean();
        res.json(ok(plans.map(withProgress), { count: plans.length }));
    } catch (e) {
        console.error('[PEI] list:', e.message);
        res.status(500).json(fail('INTERNAL_ERROR', e.message));
    }
});

/** Cria o plano ativo. Se já existe um ativo do mesmo profissional, devolve ele (idempotente). */
router.post('/', async (req, res) => {
    try {
        const { patientId, specialty, reviewDate, notes } = req.body || {};
        const doctorId = isAdmin(req.user) && req.body?.doctorId ? req.body.doctorId : req.user.id;
        if (!isId(patientId) || !isId(doctorId)) return res.status(400).json(fail('INVALID_INPUT', 'Paciente ou profissional inválido'));
        const goals = [];
        for (const raw of Array.isArray(req.body?.goals) ? req.body.goals : []) {
            const { goal, error } = cleanGoal(raw);
            if (error) return res.status(400).json(fail('INVALID_GOAL', error));
            goals.push(goal);
        }
        const existing = await PeiPlan.findOne({ patient: patientId, doctor: doctorId, status: 'active' });
        if (existing) return res.json(ok(withProgress(existing), { existing: true }));
        try {
            const plan = await PeiPlan.create({ patient: patientId, doctor: doctorId, specialty, reviewDate: reviewDate || undefined, notes, goals, createdBy: req.user.id });
            res.status(201).json(ok(withProgress(plan)));
        } catch (err) {
            if (err?.code === 11000) {
                const plan = await PeiPlan.findOne({ patient: patientId, doctor: doctorId, status: 'active' });
                return res.json(ok(withProgress(plan), { existing: true }));
            }
            throw err;
        }
    } catch (e) {
        console.error('[PEI] create:', e.message);
        res.status(500).json(fail('INTERNAL_ERROR', e.message));
    }
});

/** Edita dados do plano e metas (sem mexer no histórico). Meta sem _id é nova. */
router.put('/:id', async (req, res) => {
    try {
        const plan = await loadOwned(req, res);
        if (!plan) return;
        if (plan.status === 'closed') return res.status(409).json(fail('PEI_CLOSED', 'PEI encerrado não pode ser editado. Crie um novo.'));
        if (req.body?.reviewDate !== undefined) plan.reviewDate = req.body.reviewDate || undefined;
        if (typeof req.body?.notes === 'string') plan.notes = req.body.notes;
        if (Array.isArray(req.body?.goals)) {
            for (const raw of req.body.goals) {
                const { goal, error } = cleanGoal(raw);
                if (error) return res.status(400).json(fail('INVALID_GOAL', error));
                const existing = raw._id ? plan.goals.id(raw._id) : null;
                if (existing) {
                    Object.assign(existing, goal);
                    if (['active', 'paused'].includes(raw.status) && existing.status !== 'achieved') existing.status = raw.status;
                } else {
                    plan.goals.push(goal);
                }
            }
        }
        await plan.save();
        res.json(ok(withProgress(plan)));
    } catch (e) {
        console.error('[PEI] update:', e.message);
        res.status(500).json(fail('INTERNAL_ERROR', e.message));
    }
});

router.post('/:id/goals/:goalId/progress', async (req, res) => {
    try {
        const plan = await loadOwned(req, res);
        if (!plan) return;
        if (plan.status === 'closed') return res.status(409).json(fail('PEI_CLOSED', 'PEI encerrado.'));
        const goal = plan.goals.id(req.params.goalId);
        if (!goal) return res.status(404).json(fail('GOAL_NOT_FOUND', 'Meta não encontrada'));
        const value = num(req.body?.value);
        if (value === undefined || !validScore(value)) return res.status(400).json(fail('INVALID_VALUE', 'A medição vai de 0 a 10.'));
        applyProgress(goal, { value, note: req.body?.note ? String(req.body.note).slice(0, 500) : undefined, by: req.user.id });
        await plan.save();
        res.json(ok(withProgress(plan)));
    } catch (e) {
        console.error('[PEI] progress:', e.message);
        res.status(500).json(fail('INTERNAL_ERROR', e.message));
    }
});

router.post('/:id/close', async (req, res) => {
    try {
        const plan = await loadOwned(req, res);
        if (!plan) return;
        if (plan.status !== 'closed') { plan.status = 'closed'; plan.closedAt = new Date(); await plan.save(); }
        res.json(ok(withProgress(plan)));
    } catch (e) {
        console.error('[PEI] close:', e.message);
        res.status(500).json(fail('INTERNAL_ERROR', e.message));
    }
});

export default router;
