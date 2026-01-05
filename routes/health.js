import { claudeCircuit, openaiCircuit } from "../services/circuitBreaker.js";

router.get("/api/health/circuits", (req, res) => {
    res.json({
        claude: claudeCircuit.getStatus(),
        openai: openaiCircuit.getStatus(),
    });
});