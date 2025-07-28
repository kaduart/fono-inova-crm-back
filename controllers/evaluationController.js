import Evolution from "../models/Evolution.js";
// POST /api/evaluations
export const createEvaluation = async (req, res) => {
  try {
    const {
      doctor,
      patientId,
      valuePaid,
      paymentType,
      date,
      time,
    } = req.body;

    if (!doctor || !patientId || !valuePaid || !paymentType || !date || !time) {
      return res.status(400).json({ error: "Todos os campos são obrigatórios." });
    }

    const newEvaluation = new Evolution({
      doctor,
      patientId,
      type: "avaliação",
      valuePaid,
      paymentType,
      date,
      time,
      createdBy: req.user?.id,
    });

    await newEvaluation.save();

    return res.status(201).json(newEvaluation);
  } catch (error) {
    console.error("Erro ao criar avaliação:", error);
    return res.status(500).json({ error: "Erro ao criar avaliação." });
  }
};

// GET /api/evaluations/:patientId
export const getEvaluationsByPatient = async (req, res) => {
  const { patientId } = req.params;

  try {
    const evaluations = await Evolution.find({ patientId, type: "avaliação" })
      .populate("doctor", "fullName specialty")
      .sort({ date: -1 });

    res.status(200).json(evaluations);
  } catch (error) {
    console.error("Erro ao buscar avaliações:", error);
    res.status(500).json({ message: "Erro ao buscar avaliações." });
  }
};

export const deleteEvaluation = async (req, res) => {
  const { id } = req.params;

  try {
    const deleted = await Evolution.findByIdAndDelete(id);

    if (!deleted) {
      return res.status(404).json({ message: "Avaliação não encontrada." });
    }

    res.status(200).json({ message: "Avaliação deletada com sucesso." });
  } catch (error) {
    console.error("Erro ao deletar avaliação:", error);
    res.status(500).json({ message: "Erro interno ao deletar avaliação." });
  }
};