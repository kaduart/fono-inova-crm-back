/**
 * Helper para extrair YYYY-MM-DD de vários formatos de data
 * Aceita: "2026-04-10", "2026-04-10T12:00:00.000Z", "2026-04-10T08:00:00-03:00", Date objects
 */
function extractDateString(dateInput) {
    if (!dateInput) return null;
    
    // Se já é string no formato YYYY-MM-DD, retorna como está
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
        return dateInput;
    }
    
    // Se é ISO string (2026-04-10T12:00:00.000Z ou 2026-04-10T08:00:00-03:00)
    if (typeof dateInput === 'string' && dateInput.includes('T')) {
        // Extrai a parte da data (antes do T)
        const match = dateInput.match(/^(\d{4}-\d{2}-\d{2})/);
        if (match) return match[1];
    }
    
    // Se é objeto Date
    if (dateInput instanceof Date && !isNaN(dateInput.getTime())) {
        return dateInput.toISOString().split('T')[0];
    }
    
    return null;
}

/**
 * Helper para extrair hora no formato HH:mm de vários formatos
 * Aceita: "09:00", "2026-04-10T12:00:00.000Z", Date objects
 */
function extractTimeString(timeInput, dateInput = null) {
    if (!timeInput && !dateInput) return null;
    
    // Se já é string no formato HH:mm, retorna como está
    if (typeof timeInput === 'string' && /^\d{2}:\d{2}$/.test(timeInput)) {
        return timeInput;
    }
    
    // Se timeInput é ISO string, extrai a hora
    if (typeof timeInput === 'string' && timeInput.includes('T')) {
        // Extrai HH:mm da string ISO
        const match = timeInput.match(/T(\d{2}):(\d{2})/);
        if (match) return `${match[1]}:${match[2]}`;
    }
    
    // Se dateInput é ISO string, tenta extrair a hora de lá
    if (typeof dateInput === 'string' && dateInput.includes('T')) {
        const match = dateInput.match(/T(\d{2}):(\d{2})/);
        if (match) return `${match[1]}:${match[2]}`;
    }
    
    // Se é objeto Date
    if (timeInput instanceof Date && !isNaN(timeInput.getTime())) {
        return timeInput.toTimeString().slice(0, 5);
    }
    
    return null;
}

export const validatePackageInput = (req, res, next) => {
    let { dateTime, time, date, selectedSlots } = req.body;

    // 🔄 CONVERTE DATAS ISO PARA YYYY-MM-DD automaticamente
    
    // 1. Normaliza dateTime (se existir)
    if (dateTime && dateTime.date) {
        const normalizedDate = extractDateString(dateTime.date);
        if (normalizedDate) {
            dateTime.date = normalizedDate;
        }
        const normalizedTime = extractTimeString(dateTime.time, dateTime.date);
        if (normalizedTime) {
            dateTime.time = normalizedTime;
        }
    }
    
    // 2. Normaliza date e time (se existirem)
    if (date) {
        const normalizedDate = extractDateString(date);
        if (normalizedDate) {
            req.body.date = normalizedDate; // Atualiza no body para o controller usar
            date = normalizedDate;
        }
    }
    
    if (time) {
        const normalizedTime = extractTimeString(time, date);
        if (normalizedTime) {
            req.body.time = normalizedTime; // Atualiza no body
            time = normalizedTime;
        }
    }
    
    // 3. Normaliza selectedSlots (se existirem)
    if (selectedSlots && Array.isArray(selectedSlots)) {
        selectedSlots = selectedSlots.map(slot => ({
            ...slot,
            date: extractDateString(slot.date) || slot.date,
            time: extractTimeString(slot.time, slot.date) || slot.time
        }));
        req.body.selectedSlots = selectedSlots; // Atualiza no body
    }

    // ✅ ACEITA VÁRIOS FORMATOS:
    // 1. dateTime: { date, time } - formato legado
    // 2. date + time - formato usado pelo therapyPackageController
    // 3. selectedSlots[] - formato novo (V2), data/hora vêm nos slots
    
    const hasDateTime = dateTime && dateTime.date && dateTime.time;
    const hasDateAndTime = date && time;
    const hasSelectedSlots = selectedSlots && selectedSlots.length > 0 && selectedSlots[0].date && selectedSlots[0].time;

    if (!hasDateTime && !hasDateAndTime && !hasSelectedSlots) {
        return res.status(400).json({ 
            error: "Data e hora são obrigatórias",
            details: "Envie dateTime: {date, time}, ou date + time, ou selectedSlots com date/time"
        });
    }

    // Valida formato dateTime (legado)
    if (dateTime) {
        if (!dateTime.date || !dateTime.time) {
            return res.status(400).json({ error: "Formato de data inválido. Use {date, time}" });
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateTime.date)) {
            return res.status(400).json({ 
                error: "Formato de data inválido. Use YYYY-MM-DD", 
                received: dateTime.date 
            });
        }
        if (!/^\d{2}:\d{2}$/.test(dateTime.time)) {
            return res.status(400).json({ 
                error: "Formato de horário inválido. Use HH:mm",
                received: dateTime.time
            });
        }
    }

    // Valida formato date + time (controller therapy)
    if (date && time) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ 
                error: "Formato de data inválido. Use YYYY-MM-DD",
                received: date
            });
        }
        if (!/^\d{2}:\d{2}$/.test(time)) {
            return res.status(400).json({ 
                error: "Formato de horário inválido. Use HH:mm",
                received: time
            });
        }
    }

    next();
};
