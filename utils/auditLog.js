import AuditLog from '../models/AuditLog.js';

export const createAuditLog = async (logData, session = null) => {
    try {
        const auditLog = new AuditLog(logData);
        await auditLog.save({ session });
        return auditLog;
    } catch (error) {
        console.error('Erro ao criar log de auditoria:', error);
        throw error;
    }
};