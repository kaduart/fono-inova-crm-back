// Histórico de sessões de um paciente
router.get('/patients/:patientId/session-history', auth, async (req, res) => {
  try {
    const sessions = await TherapyPackage.aggregate([
      { $match: { patientId: new mongoose.Types.ObjectId(req.params.patientId) } },
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
    const payments = await Payment.find({ patientId: req.params.patientId }).sort({ date: -1 });
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
