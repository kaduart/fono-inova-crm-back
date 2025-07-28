export const validatePackageInput = (req, res, next) => {
    const { dateTime, time } = req.body;

    if (!dateTime && !time) {
        return res.status(400).json({ error: "Data e hora são obrigatórias" });
    }
    if (dateTime) {
        if (!dateTime.date || !dateTime.time) {
            return res.status(400).json({ error: "Formato de data inválido. Use {date, time}" });
        }

        // Valida formato da data (YYYY-MM-DD)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateTime.date)) {
            return res.status(400).json({ error: "Formato de data inválido. Use YYYY-MM-DD" });
        }

        // Valida formato do tempo (HH:mm)
        if (!/^\d{2}:\d{2}$/.test(dateTime.time)) {
            return res.status(400).json({ error: "Formato de horário inválido. Use HH:mm" });
        }
    }

    next();
};