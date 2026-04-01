// routes/invoice.routes.js
import express from 'express';
import Invoice from '../models/Invoice.js';
import { 
  createInvoice, 
  createMonthlyInvoice, 
  createPerSessionInvoice,
  cancelInvoice 
} from '../domain/invoice/index.js';
import { publishEvent } from '../infrastructure/events/eventPublisher.js';

const router = express.Router();

/**
 * @route   GET /api/v2/invoices
 * @desc    Lista faturas com filtros
 * @access  Private
 */
router.get('/', async (req, res) => {
  try {
    const {
      patientId,
      status,
      type,
      origin,
      startDate,
      endDate,
      overdue,
      page = 1,
      limit = 20
    } = req.query;

    const query = {};
    
    if (patientId) query.patient = patientId;
    if (status) query.status = status;
    if (type) query.type = type;
    if (origin) query.origin = origin;
    
    if (overdue === 'true') {
      query.dueDate = { $lt: new Date() };
      query.status = { $nin: ['paid', 'canceled'] };
    }
    
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    const invoices = await Invoice.find(query)
      .populate('patient', 'name phone email')
      .populate('doctor', 'name')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await Invoice.countDocuments(query);

    res.json({
      success: true,
      data: invoices,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('[Invoices] Erro ao listar:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @route   GET /api/v2/invoices/:id
 * @desc    Busca fatura por ID
 * @access  Private
 */
router.get('/:id', async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id)
      .populate('patient', 'name phone email address')
      .populate('doctor', 'name')
      .populate('items.appointment')
      .populate('items.session')
      .populate('payments');

    if (!invoice) {
      return res.status(404).json({
        success: false,
        error: 'INVOICE_NOT_FOUND'
      });
    }

    res.json({
      success: true,
      data: invoice
    });
  } catch (error) {
    console.error('[Invoices] Erro ao buscar:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @route   POST /api/v2/invoices
 * @desc    Cria nova fatura
 * @access  Private
 */
router.post('/', async (req, res) => {
  try {
    const {
      patientId,
      type = 'patient',
      origin = 'session',
      appointments = [],
      packageId,
      startDate,
      endDate,
      dueDate,
      discount = 0,
      notes = ''
    } = req.body;

    const result = await createInvoice({
      patientId,
      type,
      origin,
      appointments,
      packageId,
      startDate,
      endDate,
      dueDate,
      discount,
      notes,
      createdBy: req.user?._id,
      correlationId: req.correlationId
    });

    res.status(201).json(result);
  } catch (error) {
    console.error('[Invoices] Erro ao criar:', error);
    
    const errorMap = {
      'PATIENT_REQUIRED': { status: 400, message: 'Paciente é obrigatório' },
      'INVALID_TYPE': { status: 400, message: 'Tipo inválido (use patient ou insurance)' },
      'INVALID_ORIGIN': { status: 400, message: 'Origem inválida (use session, package ou batch)' },
      'INSURANCE_INVOICE_MUST_BE_BATCH': { status: 400, message: 'Fatura de convênio deve ter origin=batch' },
      'NO_ITEMS_TO_INVOICE': { status: 400, message: 'Nenhum item para faturar' },
      'SOME_APPOINTMENTS_NOT_FOUND': { status: 400, message: 'Alguns agendamentos não encontrados' }
    };

    const mapped = errorMap[error.message];
    if (mapped) {
      return res.status(mapped.status).json({
        success: false,
        error: error.message,
        message: mapped.message
      });
    }

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @route   POST /api/v2/invoices/monthly
 * @desc    Cria fatura mensal para paciente
 * @access  Private
 */
router.post('/monthly', async (req, res) => {
  try {
    const { patientId, year, month } = req.body;

    const result = await createMonthlyInvoice({
      patientId,
      year,
      month,
      correlationId: req.correlationId
    });

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.reason,
        message: 'Nenhuma sessão para faturar neste período'
      });
    }

    res.status(201).json(result);
  } catch (error) {
    console.error('[Invoices] Erro ao criar fatura mensal:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @route   POST /api/v2/invoices/per-session
 * @desc    Cria fatura per-session (uma sessão específica)
 * @access  Private
 */
router.post('/per-session', async (req, res) => {
  try {
    const { patientId, appointmentId, sessionValue } = req.body;

    const result = await createPerSessionInvoice({
      patientId,
      appointmentId,
      sessionValue,
      correlationId: req.correlationId
    });

    res.status(201).json(result);
  } catch (error) {
    console.error('[Invoices] Erro ao criar fatura per-session:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @route   PATCH /api/v2/invoices/:id/cancel
 * @desc    Cancela uma fatura
 * @access  Private
 */
router.patch('/:id/cancel', async (req, res) => {
  try {
    const { reason } = req.body;

    const result = await cancelInvoice({
      invoiceId: req.params.id,
      reason,
      userId: req.user?._id,
      correlationId: req.correlationId
    });

    res.json({
      success: true,
      message: 'Fatura cancelada com sucesso',
      invoice: result.invoice
    });
  } catch (error) {
    console.error('[Invoices] Erro ao cancelar:', error);
    
    if (error.message === 'INVOICE_NOT_FOUND') {
      return res.status(404).json({
        success: false,
        error: 'INVOICE_NOT_FOUND'
      });
    }
    
    if (error.message === 'CANNOT_CANCEL_PAID_INVOICE') {
      return res.status(400).json({
        success: false,
        error: 'CANNOT_CANCEL_PAID_INVOICE',
        message: 'Não é possível cancelar fatura já paga'
      });
    }
    
    if (error.message === 'CANNOT_CANCEL_WITH_PAYMENTS') {
      return res.status(400).json({
        success: false,
        error: 'CANNOT_CANCEL_WITH_PAYMENTS',
        message: 'Fatura tem pagamentos parciais. Estorne os pagamentos primeiro.'
      });
    }

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @route   GET /api/v2/invoices/overdue/list
 * @desc    Lista faturas vencidas
 * @access  Private
 */
router.get('/overdue/list', async (req, res) => {
  try {
    const { days = 0 } = req.query;
    
    const date = new Date();
    date.setDate(date.getDate() - parseInt(days));
    
    const invoices = await Invoice.find({
      dueDate: { $lt: date },
      status: { $nin: ['paid', 'canceled'] }
    })
    .populate('patient', 'name phone')
    .sort({ dueDate: 1 });

    res.json({
      success: true,
      count: invoices.length,
      data: invoices
    });
  } catch (error) {
    console.error('[Invoices] Erro ao listar vencidas:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @route   GET /api/v2/invoices/stats/summary
 * @desc    Estatísticas de faturas
 * @access  Private
 */
router.get('/stats/summary', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const matchStage = {};
    if (startDate || endDate) {
      matchStage.createdAt = {};
      if (startDate) matchStage.createdAt.$gte = new Date(startDate);
      if (endDate) matchStage.createdAt.$lte = new Date(endDate);
    }

    const stats = await Invoice.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          total: { $sum: '$total' },
          paid: { $sum: '$paidAmount' }
        }
      }
    ]);

    const overdue = await Invoice.countDocuments({
      dueDate: { $lt: new Date() },
      status: { $nin: ['paid', 'canceled'] }
    });

    res.json({
      success: true,
      stats,
      overdue
    });
  } catch (error) {
    console.error('[Invoices] Erro nas estatísticas:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
