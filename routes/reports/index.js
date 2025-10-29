// routes/reports/index.js
import express from "express";
import medicalReports from "./medicalReports.js";
import anamnesisReports from "./anamnesisReports.js";
import schoolReports from "./schoolReports.js";

const router = express.Router();

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