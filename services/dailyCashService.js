// services/dailyCashService.js
// 🎯 FONTE ÚNICA DE VERDADE — Wrapper sobre unifiedFinancialService.v2.js

import moment from 'moment-timezone';
import unifiedFinancialService from './unifiedFinancialService.v2.js';

const getDailyCash = async (date) => {
    const startOfDay = moment(date).startOf('day').toDate();
    const endOfDay = moment(date).endOf('day').toDate();

    const cash = await unifiedFinancialService.calculateCash(startOfDay, endOfDay);

    return [{
        totalParticular: cash.particular || 0,
        totalConvenio: cash.convenio || 0,
        totalPacote: cash.pacote || 0,
        totalLiminar: cash.liminar || 0,
        total: cash.total || 0
    }];
};

export default getDailyCash;
