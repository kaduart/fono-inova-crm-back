import express from 'express';
import mongoose from 'mongoose';
import { claudeCircuit, openaiCircuit } from "../services/circuitBreaker.js";

const router = express.Router();

// Health check básico
router.get("/", (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
    });
});

// Health check dos circuit breakers
router.get("/circuits", (req, res) => {
    res.json({
        claude: claudeCircuit.getStatus(),
        openai: openaiCircuit.getStatus(),
    });
});

export default router;