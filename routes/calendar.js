import express from 'express';
import { getHolidaysWithNames } from '../config/feriadosBR-dynamic.js';

const router = express.Router();

/**
 * GET /api/calendar/holidays?year=2025
 * Retorna todos os feriados nacionais do ano
 */
router.get('/holidays', (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const holidays = getHolidaysWithNames(year);
    
    // Mapeia para incluir o tipo (full/morning/afternoon)
    const holidaysWithType = holidays.map(h => {
      // Feriados parciais (Quarta-feira de Cinzas = manhã livre)
      const isAshWednesday = h.name === 'Quarta-feira de Cinzas';
      return {
        date: h.date,
        name: h.name,
        type: isAshWednesday ? 'morning' : 'full'
      };
    });
    
    res.json({
      success: true,
      year,
      holidays: holidaysWithType
    });
  } catch (error) {
    console.error('[calendar/holidays] Erro:', error);
    res.status(500).json({
      success: false,
      error: 'Erro ao buscar feriados'
    });
  }
});

export default router;
