// Relatório mensal (item 3) — /api/v2/monthly-reports. Ver docs/FAMILY_COMMUNICATION.md.
// Regras: números só de evoluções finalizadas; nada vai para a família sem o terapeuta aprovar;
// envio idempotente (trava atômica approved → sent + jobId fixo).
import express from 'express';
import mongoose from 'mongoose';
import MonthlyReport from '../models/MonthlyReport.js';
import Patient from '../models/Patient.js';
import Doctor from '../models/Doctor.js';
import { flexibleAuth } from '../middleware/amandaAuth.js';
import { buildMonthlyData } from '../services/clinical/monthlyReportService.js';
import { monthLabelPt, monthlyReportMessage, validateFamilyText } from '../services/clinical/familyMessages.js';
import { activeGoalsSnapshot } from '../services/clinical/peiService.js';
import { generatePdfFromTemplate } from '../services/generatePDF.js';
import { whatsappSendQueue } from '../config/bullConfig.js';
import { sanitizePhoneBeforeSend } from '../utils/phone.js';

const router = express.Router();
const isAdmin = (user) => ['admin', 'superadmin'].includes(String(user?.role || '').toLowerCase());
const ok = (data, meta = {}) => ({ success: true, data, meta: { version: 'v2', timestamp: new Date().toISOString(), ...meta } });
const fail = (code, message) => ({ success: false, error: { code, message }, message });
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ''));
const canTouch = (report, user) => isAdmin(user) || String(report.doctor) === String(user?.id);

async function loadOwned(req, res) {
    if (!isId(req.params.id)) { res.status(400).json(fail('INVALID_ID', 'ID inválido')); return null; }
    const report = await MonthlyReport.findById(req.params.id);
    if (!report) { res.status(404).json(fail('NOT_FOUND', 'Relatório não encontrado')); return null; }
    if (!canTouch(report, req.user)) { res.status(403).json(fail('FORBIDDEN', 'Só o profissional do relatório pode mexer nele')); return null; }
    return report;
}

router.get('/patient/:patientId', flexibleAuth, async (req, res) => {
    try {
        if (!isId(req.params.patientId)) return res.status(400).json(fail('INVALID_ID', 'Paciente inválido'));
        const filter = { patient: req.params.patientId };
        if (!isAdmin(req.user)) filter.doctor = req.user?.id;
        const list = await MonthlyReport.find(filter).sort({ month: -1 }).limit(24)
            .populate('doctor', 'fullName specialty').lean();
        res.json(ok(list, { count: list.length }));
    } catch (e) {
        console.error('[MonthlyReport] list:', e.message);
        res.status(500).json(fail('INTERNAL_ERROR', e.message));
    }
});

/** Gera (ou atualiza, se ainda rascunho) o relatório do mês. Idempotente por paciente+profissional+mês. */
router.post('/generate', flexibleAuth, async (req, res) => {
    try {
        const { patientId, month } = req.body || {};
        const doctorId = isAdmin(req.user) && req.body?.doctorId ? req.body.doctorId : req.user?.id;
        if (!isId(patientId) || !isId(doctorId)) return res.status(400).json(fail('INVALID_INPUT', 'Paciente ou profissional inválido'));
        if (!/^\d{4}-\d{2}$/.test(String(month || ''))) return res.status(400).json(fail('INVALID_MONTH', 'Informe o mês (AAAA-MM)'));

        const existing = await MonthlyReport.findOne({ patient: patientId, doctor: doctorId, month });
        if (existing && existing.status !== 'draft') return res.json(ok(existing, { regenerated: false }));

        const goals = await activeGoalsSnapshot({ patientId, doctorId });
        const data = await buildMonthlyData({ patientId, doctorId, month, goals });
        if (!data.sessionsWithEvolution) {
            return res.status(409).json(fail('NO_FINALIZED_EVOLUTIONS', 'Não há evolução finalizada desse paciente no mês. Finalize as evoluções antes de gerar o relatório.'));
        }
        const report = await MonthlyReport.findOneAndUpdate(
            { patient: patientId, doctor: doctorId, month, status: 'draft' },
            { $set: { data, specialty: data.specialty, generatedAt: new Date() }, $setOnInsert: { createdBy: req.user?.id } },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        ).catch(async (err) => {
            // Corrida: outro pedido aprovou entre a leitura e o upsert (E11000 no índice único).
            if (err?.code === 11000) return MonthlyReport.findOne({ patient: patientId, doctor: doctorId, month });
            throw err;
        });
        res.status(existing ? 200 : 201).json(ok(report, { regenerated: !!existing }));
    } catch (e) {
        console.error('[MonthlyReport] generate:', e.message);
        res.status(500).json(fail('INTERNAL_ERROR', e.message));
    }
});

router.put('/:id', flexibleAuth, async (req, res) => {
    try {
        const report = await loadOwned(req, res);
        if (!report) return;
        if (report.status === 'sent') return res.status(409).json(fail('ALREADY_SENT', 'Relatório já enviado à família; não dá mais para editar.'));
        for (const k of ['summary', 'nextSteps', 'familyMessage']) {
            if (typeof req.body?.[k] === 'string') report[k] = req.body[k].slice(0, 5000);
        }
        // Editar um aprovado volta para rascunho: precisa aprovar de novo.
        if (report.status === 'approved') { report.status = 'draft'; report.approvedAt = undefined; report.approvedBy = undefined; }
        await report.save();
        res.json(ok(report));
    } catch (e) {
        console.error('[MonthlyReport] update:', e.message);
        res.status(500).json(fail('INTERNAL_ERROR', e.message));
    }
});

router.post('/:id/approve', flexibleAuth, async (req, res) => {
    try {
        const report = await loadOwned(req, res);
        if (!report) return;
        if (report.status !== 'draft') return res.json(ok(report, { idempotent: true }));
        if (String(report.summary || '').trim().length < 20) {
            return res.status(400).json(fail('SUMMARY_REQUIRED', 'Escreva o resumo do mês antes de aprovar.'));
        }
        report.status = 'approved';
        report.approvedAt = new Date();
        report.approvedBy = req.user?.id;
        if (!report.familyMessage) {
            const [patient, doctor] = await Promise.all([
                Patient.findById(report.patient).select('fullName').lean(),
                Doctor.findById(report.doctor).select('fullName').lean(),
            ]);
            report.familyMessage = monthlyReportMessage({ patientName: patient?.fullName, monthLabel: monthLabelPt(report.month), doctorName: doctor?.fullName });
        }
        await report.save();
        res.json(ok(report));
    } catch (e) {
        console.error('[MonthlyReport] approve:', e.message);
        res.status(500).json(fail('INTERNAL_ERROR', e.message));
    }
});

/** Envia o aviso do relatório para a família pela fila do WhatsApp. O PDF a secretaria/terapeuta baixa e anexa. */
router.post('/:id/send', flexibleAuth, async (req, res) => {
    try {
        const report = await loadOwned(req, res);
        if (!report) return;
        if (report.status === 'sent') return res.json(ok(report, { idempotent: true }));
        if (report.status !== 'approved') return res.status(409).json(fail('NOT_APPROVED', 'Aprove o relatório antes de enviar.'));
        const text = String(req.body?.text ?? report.familyMessage ?? '').trim();
        const invalid = validateFamilyText(text);
        if (invalid) return res.status(400).json(fail('INVALID_TEXT', invalid));
        const patient = await Patient.findById(report.patient).select('phone').lean();
        const phone = sanitizePhoneBeforeSend(patient?.phone);
        if (!phone.success) return res.status(409).json(fail('NO_PHONE', 'Paciente sem telefone válido no cadastro.'));

        const claimed = await MonthlyReport.findOneAndUpdate(
            { _id: report._id, status: 'approved' },
            { $set: { status: 'sent', sentAt: new Date(), familyMessage: text, phoneLast4: phone.phone.slice(-4) } },
            { new: true }
        );
        if (!claimed) return res.json(ok(await MonthlyReport.findById(report._id), { idempotent: true }));
        try {
            await whatsappSendQueue.add('send-message', { phone: phone.phone, message: text, purpose: 'monthly_report' },
                { jobId: `monthly-${report._id}`, attempts: 3, backoff: { type: 'exponential', delay: 30_000 }, removeOnComplete: 500, removeOnFail: 500 });
        } catch (err) {
            await MonthlyReport.updateOne({ _id: report._id, status: 'sent' }, { $set: { status: 'approved' }, $unset: { sentAt: 1 } });
            console.error(`[MonthlyReport] ${report._id} não entrou na fila:`, err.message);
            return res.status(503).json(fail('QUEUE_UNAVAILABLE', 'Não foi possível enviar agora. Tente de novo em alguns minutos.'));
        }
        console.log(`[MonthlyReport] aviso enfileirado report=${report._id} user=${req.user?.id}`);
        res.json(ok(claimed));
    } catch (e) {
        console.error('[MonthlyReport] send:', e.message);
        res.status(500).json(fail('INTERNAL_ERROR', e.message));
    }
});

router.get('/:id/pdf', flexibleAuth, async (req, res) => {
    try {
        const report = await loadOwned(req, res);
        if (!report) return;
        const [patient, doctor] = await Promise.all([
            Patient.findById(report.patient).select('fullName dateOfBirth').lean(),
            Doctor.findById(report.doctor).select('fullName specialty licenseNumber').lean(),
        ]);
        const pdf = await generatePdfFromTemplate({
            report: report.toObject(), patient, doctor, monthLabel: monthLabelPt(report.month),
            draft: report.status === 'draft',
        }, 'monthlyReport');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="relatorio-${report.month}.pdf"`);
        res.send(pdf);
    } catch (e) {
        console.error('[MonthlyReport] pdf:', e.message);
        res.status(500).json(fail('INTERNAL_ERROR', e.message));
    }
});

export default router;
