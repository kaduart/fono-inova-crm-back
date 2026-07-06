// jobs/scheduledTasks.js
import cron from 'node-cron';
import { generateMonthlyCommissions } from '../services/commissionService.js';

/**
 * Executa no dia 1 de cada mês às 8h (fuso America/Sao_Paulo)
 * Cron pattern: '0 8 1 * *'
 * - 0: minuto 0
 * - 8: hora 8
 * - 1: dia 1 do mês
 * - *: todos os meses
 * - *: todos os dias da semana
 */
export const scheduleMonthlyCommissions = () => {
    cron.schedule('0 8 1 * *', async () => {
        console.log('\n🔔 Cron Job: Gerando comissões mensais...');

        try {
            const result = await generateMonthlyCommissions();

            if (result.success) {
                console.log(`✅ Comissões geradas com sucesso!`);
                console.log(`📊 ${result.generated} de ${result.totalDoctors} profissionais`);

                // 🔹 OPCIONAL: enviar email/notificação para admin
                // await sendEmailToAdmin(result);
            } else {
                console.warn('⚠️ Nenhuma comissão gerada');
            }

        } catch (error) {
            console.error('❌ Erro no cron job de comissões:', error);
            // 🔹 OPCIONAL: registrar em sistema de logs (Sentry, Datadog)
        }

    }, {
        scheduled: true,
        timezone: 'America/Sao_Paulo'
    });

    console.log('✅ Cron job de comissões mensais agendado (dia 1 às 8h)');
};

/**
 * 🔹 OPCIONAL: Endpoint manual para testar/forçar geração
 */
export const manualCommissionTrigger = async (req, res) => {
    try {
        const { month, year } = req.body || {};
        const result = await generateMonthlyCommissions(month ? Number(month) : undefined, year ? Number(year) : undefined);
        res.json({
            success: true,
            message: 'Comissões geradas manualmente',
            data: result
        });
    } catch (error) {
        if (error.message === 'GENERATION_ALREADY_IN_PROGRESS') {
            return res.status(409).json({
                success: false,
                message: 'Geração de comissões já está em andamento. Aguarde a conclusão.',
                error: error.message
            });
        }

        res.status(500).json({
            success: false,
            message: 'Erro ao gerar comissões',
            error: error.message
        });
    }
};