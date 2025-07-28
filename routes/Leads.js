import express from 'express';
import { auth, authorize } from '../middleware/auth.js';
import validateId from '../middleware/validateId.js';
import Leads from '../models/Leads.js';
const router = express.Router();

router.use(auth);

// Listar leads com filtros
router.get('/', authorize(['admin', 'secretary', 'professional']), async (req, res) => {
  const { status, origin, from, to } = req.query;
  const filters = {};
  if (status) filters.status = status;
  if (origin) filters.origin = origin;
  if (from && to) filters.createdAt = { $gte: new Date(from), $lte: new Date(to) };
  const leads = await Leads.find(filters);
  res.json(leads);
});

// Detalhar lead
router.get('/:id', validateId, auth, authorize(['admin', 'secretary', 'professional']), async (req, res) => {
  const lead = await Leads.findById(req.params.id);
  if (!lead) return res.status(404).json({ message: 'Lead não encontrado' });
  res.json(lead);
});

// Criar novo lead
router.post('/', authorize(['admin', 'secretary']), async (req, res) => {
  const lead = new Lead(req.body);
  await leads.save();
  res.status(201).json(lead);
});

// Atualizar lead
router.put('/:id', validateId, auth, authorize(['admin', 'secretary', 'professional']), async (req, res) => {
  const lead = await Leads.findByIdAndUpdate(req.params.id, req.body, { new: true });
  res.json(lead);
});

// Deletar lead (marcar perdido)
router.delete('/:id', validateId, auth, authorize(['admin', 'secretary']), async (req, res) => {
  // opcional: soft delete, aqui removemos
  await Leads.findByIdAndDelete(req.params.id);
  res.status(204).end();
});

// Relatório de leads por status e origem
router.get('/report/summary', authorize(['admin', 'secretary']), async (req, res) => {
  const summary = await Leads.aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } }
  ]);
  const originSummary = await Leads.aggregate([
    { $group: { _id: '$origin', count: { $sum: 1 } } }
  ]);
  res.json({ byStatus: summary, byOrigin: originSummary });
});

export default router;
