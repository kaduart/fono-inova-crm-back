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