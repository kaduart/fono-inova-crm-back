import Evolution from "../models/Evolution.js";
import Metric from "../models/Metric.js";

// Criar avaliação
// controllers/evolutionController.js
import mongoose from 'mongoose';



// Função auxiliar para clamp de números
const clampNumber = (num, min, max) => Math.min(Math.max(num, min), max);

export const createEvaluation = async (req, res) => {
  try {
    const {
      patient,
      doctor,
      specialty,
      date,      // 'yyyy-MM-dd' - será convertido para Date
      time,      // 'HH:mm'
      content = '',
      metrics = [],
      evaluationAreas = [],
      evaluationTypes = [],
      plan = "",
      treatmentStatus = 'in_progress' // ✅ VALOR PADRÃO DO SCHEMA
    } = req.body || {};

    // 🔎 Validações básicas
    if (!patient || !mongoose.Types.ObjectId.isValid(patient)) {
      return res.status(400).json({ message: 'Paciente inválido' });
    }
    if (!doctor || !mongoose.Types.ObjectId.isValid(doctor)) {
      return res.status(400).json({ message: 'Médico inválido' });
    }
    if (!date) {
      return res.status(400).json({ message: 'Data é obrigatória' });
    }
    if (!specialty) {
      return res.status(400).json({ message: 'Especialidade é obrigatória' });
    }

    // ✅ CONVERTER DATE STRING PARA DATE OBJECT
    let dateObj;
    try {
      // Tenta converter a string para Date
      dateObj = new Date(date);
      if (isNaN(dateObj.getTime())) {
        throw new Error('Data inválida');
      }
    } catch (error) {
      return res.status(400).json({ message: 'Data inválida' });
    }

    // 🧹 Normaliza métricas -> array {name, value:number}
    const normalizedMetrics = Array.isArray(metrics)
      ? metrics
        .map(m => ({
          name: String(m?.name || '').trim(),
          value: Number(m?.value),
        }))
        .filter(m => m.name && Number.isFinite(m.value))
      : [];

    // 🧹 Normaliza áreas -> array {id, name, score:number(0..10)}
    const normalizedAreas = Array.isArray(evaluationAreas)
      ? evaluationAreas
        .map(a => ({
          id: String(a?.id || '').trim(),
          name: String(a?.name || '').trim() || String(a?.id || '').trim(),
          score: clampNumber(Number(a?.score), 0, 10),
        }))
        .filter(a => a.id && Number.isFinite(a.score))
      : [];

    // ↪️ Se não vierem types, deriva dos sliders (score >= 1)
    const derivedTypes = normalizedAreas.filter(a => a.score >= 1).map(a => a.id);
    const finalEvaluationTypes = Array.isArray(evaluationTypes) && evaluationTypes.length
      ? evaluationTypes.filter(type =>
        ['language', 'motor', 'cognitive', 'behavior', 'social'].includes(type)
      )
      : derivedTypes;

    // ✅ MONTA O OBJETO ALINHADO COM O SCHEMA
    const evaluationData = {
      patient: new mongoose.Types.ObjectId(patient),
      doctor: new mongoose.Types.ObjectId(doctor),
      specialty: String(specialty).trim(),
      date: dateObj, // ✅ Date object (conforme schema)
      time: time ? String(time).trim() : undefined,
      content: String(content || '').trim(),
      metrics: normalizedMetrics,
      evaluationAreas: normalizedAreas,
      evaluationTypes: finalEvaluationTypes,
      plan: String(plan || '').trim(),
      treatmentStatus: treatmentStatus,
      createdBy: new mongoose.Types.ObjectId(req.user.id),

    };
    // ✅ VALIDAÇÃO ADICIONAL DO TREATMENT STATUS
    const validStatuses = ['initial_evaluation', 'in_progress', 'improving', 'stable', 'regressing', 'completed'];
    if (!validStatuses.includes(evaluationData.treatmentStatus)) {
      evaluationData.treatmentStatus = 'in_progress'; // fallback para padrão
    }

    console.log('Dados da avaliação a ser salva:', evaluationData);

    const evaluation = new Evolution(evaluationData);
    await evaluation.save();

    // ✅ POPULA OS DADOS RELACIONADOS PARA RETORNO
    const populatedEvaluation = await Evolution.findById(evaluation._id)
      .populate('patient', 'fullName birthDate gender')
      .populate('doctor', 'fullName specialty');

    return res.status(201).json(populatedEvaluation);

  } catch (error) {
    console.error('Erro detalhado ao criar avaliação:', error);

    // ✅ TRATAMENTO DE ERROS MAIS ESPECÍFICO
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        message: 'Erro de validação',
        errors: errors
      });
    }

    if (error.code === 11000) {
      return res.status(400).json({
        message: 'Duplicação de dados',
        error: 'Já existe uma avaliação com esses dados'
      });
    }

    return res.status(500).json({
      message: 'Erro interno no servidor',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Erro desconhecido'
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

    try {
      if (typeof SaveEvolutionHistory === "function") {
        await SaveEvolutionHistory(id, req.user.id, "DELETE", deleted.toObject());
      }
    } catch (e) {
      console.warn("Falha ao salvar histórico:", e?.message);
    }

    return res.status(200).json({ message: "Avaliação excluída com sucesso." });
  } catch (error) {
    console.error("Erro ao deletar avaliação:", error);
    return res.status(500).json({ message: "Erro ao deletar avaliação." });
  }
};

