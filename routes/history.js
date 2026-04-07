import express from 'express';
import mongoose from 'mongoose';
import { auth, authorize } from '../middleware/auth.js';
import TherapyPackage from '../models/TherapyPackage.js';
import Payment from '../models/Payment.js';
import Evolution from '../models/Evolution.js';

const router = express.Router();

// Helper para resolver patientId (pode vir do patients_view)
async function resolvePatientId(patientId) {
  if (!mongoose.Types.ObjectId.isValid(patientId)) {
    return patientId;
  }
  
  let resolvedPatientId = patientId;
  const patientExists = await mongoose.connection.db.collection('patients').findOne(
    { _id: new mongoose.Types.ObjectId(patientId) },
    { projection: { _id: 1 } }
  );
  if (!patientExists) {
    const viewDoc = await mongoose.connection.db.collection('patients_view').findOne(
      { _id: new mongoose.Types.ObjectId(patientId) },
      { projection: { patientId: 1 } }
    );
    if (viewDoc?.patientId) {
      resolvedPatientId = viewDoc.patientId.toString();
    }
  }
  return resolvedPatientId;
}

// Histórico de sessões de um paciente
router.get('/patients/:patientId/session-history', auth, async (req, res) => {
  try {
    const resolvedPatientId = await resolvePatientId(req.params.patientId);
    
    const sessions = await TherapyPackage.aggregate([
      { $match: { patientId: new mongoose.Types.ObjectId(resolvedPatientId) } },
      { $unwind: '$sessions' },
      { $sort: { 'sessions.date': -1 } },
      {
        $project: {
          _id: 0,
          session: '$sessions'
        }
      }
    ]);

    res.json(sessions.map(s => s.session));
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar histórico de sessões' });
  }
});

// Histórico de pagamentos
router.get('/patients/:patientId/payment-history', auth, async (req, res) => {
  try {
    const resolvedPatientId = await resolvePatientId(req.params.patientId);
    
    const payments = await Payment.find({ patientId: resolvedPatientId }).sort({ date: -1 });
    res.json(payments);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar histórico de pagamentos' });
  }
});


// Criar uma avaliação como uma evolução do tipo "avaliação"
router.post('/availables', authorize(['admin', 'professional']), async (req, res) => {
  try {
    const {
      doctorId,
      sessionType,
      paymentType,
      date,
      time,
      patientId, // certifique-se de enviar isso do frontend
    } = req.body;

    if (!doctorId || !sessionType || !paymentType || !date || !time || !patientId) {
      return res.status(400).json({ error: "Todos os campos são obrigatórios." });
    }

    const newEvaluation = new Evolution({
      doctorId,
      patientId,
      type: "avaliação",
      sessionType,
      paymentType,
      date,
      time,
      createdBy: req.user.id
    });

    await newEvaluation.save();

    res.status(201).json(newEvaluation);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao criar avaliação." });
  }
});

export default router;
