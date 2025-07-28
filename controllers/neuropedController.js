import Evolution from "../models/Evolution.js";
//import createNeuropedReport from '../middleware/specialtyMiddleware.js';

module.exports = {
  createAssessment: async (req, res) => {
    try {
      const assessmentData = {
        ...req.body,
        specialty: 'neuroped',
        therapist: req.user.id
      };
      
      const newAssessment = await Evolution.create(assessmentData);
      await createNeuropedReport(newAssessment);
      
      res.status(201).json(newAssessment);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  },
  
  getDevelopmentalHistory: async (req, res) => {
    // Lógica para histórico desenvolvimental
  }
};