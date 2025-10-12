import express from 'express';
import { auth, authorize } from '../middleware/auth.js';
import validateId from '../middleware/validateId.js';
import Lead from '../models/Leads.js';

const router = express.Router();

router.use(auth);

// Listar leads com filtros e paginação
router.get('/', authorize(['admin', 'secretary', 'professional']), async (req, res) => {
  try {
    const { status, origin, from, to, page = 1, limit = 20, search } = req.query;
    const filters = {};
    if (status) filters.status = status;
    if (origin) filters.origin = origin;
    if (from && to) filters.createdAt = { $gte: new Date(from), $lte: new Date(to) };
    if (search) filters['name'] = { $regex: search, $options: 'i' };

    const leads = await Lead.find(filters)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await Lead.countDocuments(filters);
    res.json({ data: leads, total });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Detalhar lead
router.get('/:id', validateId, authorize(['admin', 'secretary', 'professional']), async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ message: 'Lead não encontrado' });
    res.json(lead);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Criar novo lead
router.post('/', authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const lead = new Lead(req.body);
    await lead.save();
    res.status(201).json(lead);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Atualizar lead
router.put('/:id', validateId, authorize(['admin', 'secretary', 'professional']), async (req, res) => {
  try {
    const lead = await Lead.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(lead);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Deletar lead
router.delete('/:id', validateId, authorize(['admin', 'secretary']), async (req, res) => {
  try {
    await Lead.findByIdAndDelete(req.params.id);
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Relatórios otimizados
router.get('/report/summary', authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const summary = await Lead.aggregate([
      {
        $facet: {
          byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
          byOrigin: [{ $group: { _id: '$origin', count: { $sum: 1 } } }]
        }
      }
    ]);
    res.json(summary[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
