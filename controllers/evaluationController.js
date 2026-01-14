import Evolution from "../models/Evolution.js";
import Metric from "../models/Metric.js";
import TherapyProtocol from "../models/TherapyProtocol.js";
import EvolutionHistory from "../models/EvolutionHistory.js";
import mongoose from 'mongoose';

// ========== FUNÇÕES AUXILIARES ==========

const clampNumber = (num, min, max) => Math.min(Math.max(num, min), max);

const saveEvolutionHistory = async (evolutionId, userId, action, previousData = null, newData = null, changes = [], reason = '') => {
  try {
    const historyEntry = new EvolutionHistory({
      evolutionId,
      changedBy: userId,
      action,
      previousData,
      newData,
      changes,
      reason
    });
    await historyEntry.save();
  } catch (error) {
    console.error('Erro ao salvar histórico:', error);
  }
};

const calculateFieldChanges = (oldData, newData) => {
  const changes = [];
  const fields = ['treatmentStatus', 'plan', 'therapeuticPlan', 'observations'];

  fields.forEach(field => {
    if (JSON.stringify(oldData[field]) !== JSON.stringify(newData[field])) {
      changes.push({
        field,
        oldValue: oldData[field],
        newValue: newData[field]
      });
    }
  });

  return changes;
};

// ========== CREATE EVALUATION (ATUALIZADO) ==========

export const createEvaluation = async (req, res) => {
  try {
    const {
      patient,
      doctor,
      specialty,
      date,
      time,
      content = '',
      metrics = [],
      evaluationAreas = [],
      evaluationTypes = [],
      plan = "",
      treatmentStatus = 'in_progress',
      // NOVOS CAMPOS
      therapeuticPlan = null,
      protocolCode = null
    } = req.body || {};

    // Validações básicas (mantidas)
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

    // Converter date string para Date object
    let dateObj;
    try {
      dateObj = new Date(date);
      if (isNaN(dateObj.getTime())) {
        throw new Error('Data inválida');
      }
    } catch (error) {
      return res.status(400).json({ message: 'Data inválida' });
    }

    // Normalizar métricas
    const normalizedMetrics = Array.isArray(metrics)
      ? metrics
        .map(m => ({
          name: String(m?.name || '').trim(),
          value: Number(m?.value),
          unit: m?.unit || '',
          notes: m?.notes || ''
        }))
        .filter(m => m.name && Number.isFinite(m.value))
      : [];

    // Normalizar áreas
    const normalizedAreas = Array.isArray(evaluationAreas)
      ? evaluationAreas
        .map(a => ({
          id: String(a?.id || '').trim(),
          name: String(a?.name || '').trim() || String(a?.id || '').trim(),
          score: clampNumber(Number(a?.score), 0, 10),
        }))
        .filter(a => a.id && Number.isFinite(a.score))
      : [];

    // Derivar types dos sliders
    const derivedTypes = normalizedAreas.filter(a => a.score >= 1).map(a => a.id);
    const finalEvaluationTypes = Array.isArray(evaluationTypes) && evaluationTypes.length
      ? evaluationTypes.map(type => String(type).trim()).filter(Boolean)
      : derivedTypes;

    // ========== PROCESSAR PLANO TERAPÊUTICO ==========
    let processedTherapeuticPlan = null;
    let activeProtocolCodes = [];

    if (protocolCode || therapeuticPlan) {
      // Buscar protocolo se código fornecido
      let protocolData = null;
      if (protocolCode) {
        protocolData = await TherapyProtocol.findOne({ code: protocolCode, active: true });
        if (protocolData) {
          await protocolData.incrementUsage();
        }
      }

      // Estruturar plano terapêutico
      processedTherapeuticPlan = {
        protocol: protocolData ? {
          code: protocolData.code,
          name: protocolData.name,
          customNotes: therapeuticPlan?.protocol?.customNotes || ''
        } : (therapeuticPlan?.protocol || {}),

        objectives: Array.isArray(therapeuticPlan?.objectives)
          ? therapeuticPlan.objectives.map(obj => ({
            area: obj.area,
            description: obj.description,
            targetScore: clampNumber(Number(obj.targetScore || 0), 0, 10),
            currentScore: clampNumber(Number(obj.currentScore || 0), 0, 10),
            targetDate: obj.targetDate ? new Date(obj.targetDate) : null,
            achieved: false,
            progress: 0,
            notes: obj.notes || ''
          }))
          : [],

        interventions: Array.isArray(therapeuticPlan?.interventions)
          ? therapeuticPlan.interventions.map(int => ({
            description: int.description,
            frequency: int.frequency || '',
            responsible: int.responsible || 'therapist',
            status: 'active',
            startDate: new Date(),
            notes: int.notes || ''
          }))
          : [],

        reviewDate: therapeuticPlan?.reviewDate
          ? new Date(therapeuticPlan.reviewDate)
          : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // +30 dias

        planVersion: 1,
        versionHistory: []
      };

      if (protocolCode) {
        activeProtocolCodes = [protocolCode];
      }
    }

    // Validar treatment status
    const validStatuses = ['initial_evaluation', 'in_progress', 'improving', 'stable', 'regressing', 'completed'];
    const finalStatus = validStatuses.includes(treatmentStatus) ? treatmentStatus : 'in_progress';

    // Montar objeto final
    const evaluationData = {
      patient: new mongoose.Types.ObjectId(patient),
      doctor: new mongoose.Types.ObjectId(doctor),
      specialty: String(specialty).trim(),
      date: dateObj,
      time: time ? String(time).trim() : undefined,
      content: String(content || '').trim(),
      metrics: normalizedMetrics,
      evaluationAreas: normalizedAreas,
      evaluationTypes: finalEvaluationTypes,
      plan: String(plan || '').trim(),
      treatmentStatus: finalStatus,
      createdBy: new mongoose.Types.ObjectId(req.user.id),
      therapeuticPlan: processedTherapeuticPlan,
      activeProtocols: activeProtocolCodes
    };

    console.log('💾 Criando avaliação:', {
      patient,
      hasTherapeuticPlan: !!processedTherapeuticPlan,
      protocolCode: activeProtocolCodes[0]
    });

    const evolution = new Evolution(evaluationData);

    // Calcular progresso dos objetivos
    if (evolution.therapeuticPlan?.objectives) {
      evolution.calculateObjectivesProgress();
    }

    await evolution.save();

    // Salvar histórico
    await saveEvolutionHistory(
      evolution._id,
      req.user.id,
      'CREATE',
      null,
      evolution.toObject(),
      [],
      'Criação inicial da avaliação'
    );

    // Popular e retornar
    const populatedEvaluation = await Evolution.findById(evolution._id)
      .populate('patient', 'fullName birthDate gender')
      .populate('doctor', 'fullName specialty');

    return res.status(201).json(populatedEvaluation);

  } catch (error) {
    console.error('❌ Erro ao criar avaliação:', error);

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

// ========== GET EVALUATIONS BY PATIENT (MANTIDO) ==========

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

// ========== GET CHART DATA (MANTIDO) ==========

export const getEvaluationChartData = async (req, res) => {
  const { patientId } = req.params;

  try {
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

// ========== UPDATE EVALUATION (MELHORADO) ==========

export const updateEvaluation = async (req, res) => {
  const { id } = req.params;
  const updatedData = req.body;

  try {
    const evolution = await Evolution.findById(id);
    if (!evolution) {
      return res.status(404).json({ error: 'Avaliação não encontrada' });
    }

    // Verificar permissão
    if (evolution.createdBy.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Sem permissão para editar' });
    }

    // Salvar dados anteriores
    const previousData = evolution.toObject();

    // Detectar mudança de plano terapêutico
    const planChanged = JSON.stringify(previousData.therapeuticPlan) !== JSON.stringify(updatedData.therapeuticPlan);

    if (planChanged && updatedData.therapeuticPlan) {
      evolution.incrementPlanVersion(
        req.user.id,
        updatedData.planChangeReason || 'Atualização do plano terapêutico'
      );
    }

    // Atualizar campos
    Object.assign(evolution, updatedData);

    // Recalcular progresso se objetivos mudaram
    if (evolution.therapeuticPlan?.objectives) {
      evolution.calculateObjectivesProgress();
    }

    await evolution.save();

    // Calcular mudanças específicas
    const changes = calculateFieldChanges(previousData, evolution.toObject());

    // Registrar histórico
    await saveEvolutionHistory(
      id,
      req.user.id,
      planChanged ? 'PLAN_CHANGE' : 'UPDATE',
      previousData,
      evolution.toObject(),
      changes,
      updatedData.updateReason || ''
    );

    res.status(200).json(evolution);
  } catch (error) {
    console.error("Erro ao atualizar avaliação:", error);
    res.status(500).json({ message: "Erro ao atualizar avaliação." });
  }
};

// ========== DELETE EVALUATION (MANTIDO) ==========

export const deleteEvaluation = async (req, res) => {
  const { id } = req.params;
  try {
    const deleted = await Evolution.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({ message: "Avaliação não encontrada." });
    }

    await saveEvolutionHistory(
      id,
      req.user.id,
      'DELETE',
      deleted.toObject(),
      null,
      [],
      req.body.deleteReason || 'Exclusão de avaliação'
    );

    return res.status(200).json({ message: "Avaliação excluída com sucesso." });
  } catch (error) {
    console.error("Erro ao deletar avaliação:", error);
    return res.status(500).json({ message: "Erro ao deletar avaliação." });
  }
};

// ========== NOVOS ENDPOINTS ==========

// GET /evolutions/patient/:patientId/progress
export const getPatientProgress = async (req, res) => {
  const { patientId } = req.params;

  try {
    const evolutions = await Evolution.find({
      patient: patientId,
      'therapeuticPlan.objectives': { $exists: true, $not: { $size: 0 } }
    })
      .populate('doctor', 'fullName specialty')
      .sort({ date: 1 });

    if (!evolutions.length) {
      return res.status(200).json({
        message: 'Nenhum plano terapêutico encontrado',
        objectives: []
      });
    }

    const latestEvolution = evolutions[evolutions.length - 1];
    const currentPlan = latestEvolution.therapeuticPlan;

    // Calcular tendência de cada objetivo
    const objectivesProgress = currentPlan.objectives.map(objective => {
      const areaHistory = evolutions
        .filter(ev => ev.evaluationAreas.some(area => area.id === objective.area))
        .map(ev => ({
          date: ev.date,
          score: ev.evaluationAreas.find(area => area.id === objective.area)?.score || 0
        }));

      // Calcular tendência (últimas 3 medições)
      let trend = 'stable';
      if (areaHistory.length >= 2) {
        const recent = areaHistory.slice(-3).map(h => h.score);
        const diff = recent[recent.length - 1] - recent[0];
        if (diff > 0.5) trend = 'improving';
        else if (diff < -0.5) trend = 'regressing';
      }

      // Estimativa de conclusão (linear)
      let projectedCompletion = null;
      if (objective.targetScore && areaHistory.length >= 2) {
        const firstScore = areaHistory[0].score;
        const lastScore = areaHistory[areaHistory.length - 1].score;
        const progress = lastScore - firstScore;
        const remaining = objective.targetScore - lastScore;

        if (progress > 0) {
          const daysElapsed = (areaHistory[areaHistory.length - 1].date - areaHistory[0].date) / (1000 * 60 * 60 * 24);
          const daysPerPoint = daysElapsed / progress;
          const daysRemaining = daysPerPoint * remaining;
          projectedCompletion = new Date(Date.now() + daysRemaining * 24 * 60 * 60 * 1000);
        }
      }

      return {
        area: objective.area,
        description: objective.description,
        target: objective.targetScore,
        current: objective.currentScore,
        progress: objective.progress,
        achieved: objective.achieved,
        trend,
        history: areaHistory,
        projectedCompletion,
        targetDate: objective.targetDate
      };
    });

    // Estatísticas do protocolo
    let protocolStats = null;
    if (currentPlan.protocol?.code) {
      const protocol = await TherapyProtocol.findOne({ code: currentPlan.protocol.code });
      const sessionsCompleted = evolutions.length;
      const overallImprovement = objectivesProgress.reduce((sum, obj) => sum + obj.progress, 0) / objectivesProgress.length || 0;

      protocolStats = {
        code: currentPlan.protocol.code,
        name: currentPlan.protocol.name,
        sessionsCompleted,
        overallImprovement: Math.round(overallImprovement),
        usageCount: protocol?.usageCount || 0,
        successRate: protocol?.successRate || 0
      };
    }

    res.status(200).json({
      patient: latestEvolution.patient,
      currentPlan: {
        protocol: currentPlan.protocol,
        version: currentPlan.planVersion,
        reviewDate: currentPlan.reviewDate
      },
      objectives: objectivesProgress,
      protocolEffectiveness: protocolStats,
      totalSessions: evolutions.length,
      treatmentStatus: latestEvolution.treatmentStatus
    });

  } catch (error) {
    console.error('Erro ao buscar progresso:', error);
    res.status(500).json({
      message: 'Erro ao buscar progresso do paciente',
      error: error.message
    });
  }
};

// GET /evolutions/patient/:patientId/history
export const getPatientEvolutionHistory = async (req, res) => {
  const { patientId } = req.params;
  const { limit = 50 } = req.query;

  try {
    const evolutions = await Evolution.find({ patient: patientId })
      .select('_id date')
      .sort({ date: -1 })
      .limit(parseInt(limit));

    const evolutionIds = evolutions.map(ev => ev._id);

    const history = await EvolutionHistory.find({
      evolutionId: { $in: evolutionIds }
    })
      .populate('changedBy', 'fullName email')
      .populate('evolutionId', 'date specialty')
      .sort({ createdAt: -1 });

    res.status(200).json(history);
  } catch (error) {
    console.error('Erro ao buscar histórico:', error);
    res.status(500).json({ message: 'Erro ao buscar histórico' });
  }
};