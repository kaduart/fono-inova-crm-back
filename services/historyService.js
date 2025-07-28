import EvolutionHistory from '../models/EvolutionHistory.js';

const SaveEvolutionHistory = async (evolutionId, changedBy, action, previousData) => {
    const history = new EvolutionHistory({
        evolutionId,
        changedBy,
        action,
        previousData
    });

    await history.save();
};

export default SaveEvolutionHistory;
