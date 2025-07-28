const mongoose = require('mongoose');

const NeuropedAssessmentSchema = new mongoose.Schema({
  patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Paciente', required: true },
  evolutionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Evolution', required: true },
  assessmentDate: { type: Date, default: Date.now },
  developmentalMilestones: [{
    domain: String,
    milestone: String,
    status: { type: String, enum: ['achieved', 'delayed', 'regressed'] }
  }],
  seizureRecords: [{
    date: Date,
    duration: Number,
    type: String,
    triggers: [String]
  }],
  sensoryProfile: {
    auditory: { type: String, enum: ['normal', 'hypersensitive', 'hyposensitive'] },
    visual: { type: String, enum: ['normal', 'hypersensitive', 'hyposensitive'] }
  }
});

module.exports = mongoose.model('NeuropedAssessment', NeuropedAssessmentSchema);