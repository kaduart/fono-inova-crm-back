// routes/reports/index.js
import express from "express";
import medicalReports from "./medicalReports.js";
import anamnesisReports from "./anamnesisReports.js";
import schoolReports from "./schoolReports.js";
import mongoose from "mongoose";
import { auth } from "../../middleware/auth.js";

const router = express.Router();

// Relatórios clínicos são dado de saúde (LGPD): exigem login. Antes desta
// linha a rota estava aberta para qualquer pessoa na internet.
router.use(auth);

// Autor do relatório vem do usuário logado, nunca do body. Os três modelos
// exigem createdBy e createdByName; sem isso todo POST dava 500.
router.use(async (req, res, next) => {
    if (req.method !== 'POST') return next();
    try {
        const modelName = ['admin', 'secretary'].includes(req.user?.role) ? 'Admin' : 'Doctor';
        const author = await mongoose.model(modelName).findById(req.user.id).select('fullName').lean();
        req.body = {
            ...req.body,
            createdBy: req.user.id,
            createdByName: author?.fullName || 'Profissional',
        };
    } catch (err) {
        console.warn('[reports] não foi possível resolver o autor:', err.message);
        req.body = { ...req.body, createdBy: req.user.id, createdByName: req.body?.createdByName || 'Profissional' };
    }
    next();
});

// Editar ou excluir relatório: só o autor ou a equipe (admin/secretária).
// Antes qualquer usuário logado alterava ou apagava o relatório de outro profissional.
const REPORT_MODELS = { medical: 'MedicalReport', anamnesis: 'AnamnesisReport', school: 'SchoolReport' };
router.use(async (req, res, next) => {
    if (req.method !== 'PUT' && req.method !== 'DELETE') return next();
    const [, kind, id, extra] = req.path.split('/');
    const modelName = REPORT_MODELS[kind];
    if (!modelName || !id || extra !== undefined || !mongoose.isValidObjectId(id)) return next();
    try {
        const doc = await mongoose.model(modelName).findById(id).select('createdBy').lean();
        if (!doc) return next(); // a rota responde 404
        const isStaff = ['admin', 'secretary'].includes(req.user?.role);
        const isAuthor = doc.createdBy && String(doc.createdBy) === String(req.user?.id);
        if (!isStaff && !isAuthor) {
            return res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'Só quem escreveu o relatório (ou a equipe da clínica) pode alterar ou excluir.' });
        }
        if (req.method === 'PUT' && req.body) {
            // Autor não muda na edição.
            delete req.body.createdBy;
            delete req.body.createdByName;
        }
        next();
    } catch (err) {
        console.error('[reports] falha ao checar autor:', err.message);
        return res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Não foi possível verificar a permissão do relatório.' });
    }
});

// Usar as rotas específicas
router.use('/medical', medicalReports);
router.use('/anamnesis', anamnesisReports);
router.use('/school', schoolReports);

// Rota de health check para relatórios
router.get('/health', (req, res) => {
    res.json({
        success: true,
        message: 'Reports API is running',
        timestamp: new Date().toISOString()
    });
});

export default router;