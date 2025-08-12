import Evolution from "../models/Evolution.js";
import Metric from "../models/Metric.js";

// Criar avaliação
export const createEvaluation = async (req, res) => {
  console.log("Dados recebidos:", req.body);

  try {

    const evaluationData = {
      ...req.body,
      metrics: req.body.metrics 
    };

    const evaluation = new Evolution(evaluationData);
    await evaluation.save();

    res.status(201).json(evaluation);
  } catch (error) {
    console.error("Erro ao criar avaliação:", error);
    res.status(400).json({
      message: "Erro na criação da avaliação",
      error: error.message
    });
  }
};

// Obter avaliações por paciente
export const getEvaluationsByPatient = async (req, res) => {
  const { patientId } = req.params;
  try {
    const evaluations = await Evolution.find({ patient: patientId })
      .populate("doctor", "fullName specialty")
      .sort({ date: -1 });
    res.status(200).json(evaluations);
  } catch (error) {
    console.error("Erro ao buscar avaliações:", error);
    res.status(500).json({ message: "Erro ao buscar avaliações." });
  }
};

// Dados para gráficos
export const getEvaluationChartData = async (req, res) => {
  const { patientId } = req.params;

  try {
    // CONSULTA CORRIGIDA: Verificar arrays não vazios de forma válida
    const evaluations = await Evolution.find({
      patient: patientId,
      metrics: { $exists: true, $not: { $size: 0 } }
    }).sort({ date: 1 });

    const allMetrics = await Metric.find();
    const metricConfig = allMetrics.reduce((acc, metric) => {
      acc[metric.name] = metric;
      return acc;
    }, {});

    const chartData = { dates: [], metrics: {}, evaluationTypes: {} };

    evaluations.forEach(evaluation => {
      const dateStr = evaluation.date.toISOString().split('T')[0];
      chartData.dates.push(dateStr);

      // Processar métricas - CORREÇÃO IMPORTANTE AQUI TAMBÉM
      if (evaluation.metrics && Array.isArray(evaluation.metrics)) {
        evaluation.metrics.forEach(metric => {
          if (!metric.name) return;

          const metricName = metric.name;
          const value = metric.value;

          if (!chartData.metrics[metricName]) {
            chartData.metrics[metricName] = {
              values: [],
              config: metricConfig[metricName] || {}
            };
          }
          chartData.metrics[metricName].values.push(value);
        });
      }

      // Processar tipos de avaliação
      if (evaluation.evaluationTypes && Array.isArray(evaluation.evaluationTypes)) {
        evaluation.evaluationTypes.forEach(type => {
          if (!chartData.evaluationTypes[type]) {
            chartData.evaluationTypes[type] = [];
          }
          chartData.evaluationTypes[type].push(1);
        });
      }
    });

    res.status(200).json(chartData);
  } catch (error) {
    console.error("Erro ao buscar dados para gráficos:", error);
    res.status(500).json({
      message: "Erro ao buscar dados para gráficos.",
      error: error.message
    });
  }
};

// Atualizar avaliação
export const updateEvaluation = async (req, res) => {
  const { id } = req.params;
  const updatedData = req.body;

  try {
    const evolution = await Evolution.findById(id);
    if (!evolution) return res.status(404).json({ error: 'Avaliação não encontrada' });

    // Verificar permissão
    if (evolution.createdBy.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Sem permissão para editar' });
    }

    // Salvar histórico antes de atualizar
    const previousData = { ...evolution.toObject() };
    Object.assign(evolution, updatedData);
    await evolution.save();

    // Registrar histórico
    await SaveEvolutionHistory(id, req.user.id, 'UPDATE', previousData);

    res.status(200).json(evolution);
  } catch (error) {
    console.error("Erro ao atualizar avaliação:", error);
    res.status(500).json({ message: "Erro ao atualizar avaliação." });
  }
};

// Excluir avaliação
export const deleteEvaluation = async (req, res) => {
  const { id } = req.params;
  try {
    const deleted = await Evolution.findByIdAndDelete(id);
    if (!deleted) return res.status(404).json({ message: "Avaliação não encontrada." });

    // Registrar histórico
    await SaveEvolutionHistory(id, req.user.id, 'DELETE', deleted.toObject());

    res.status(200).json({ message: "Avaliação excluída com sucesso." });
  } catch (error) {
    console.error("Erro ao deletar avaliação:", error);
    res.status(500).json({ message: "Erro ao deletar avaliação." });
  }
};