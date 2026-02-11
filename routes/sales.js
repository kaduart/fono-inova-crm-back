import express from 'express';
import { auth, authorize } from '../middleware/auth.js';

const router = express.Router();

// Criar venda completa com provisionamento
router.post('/', auth, authorize(['admin', 'secretary']), async (req, res) => {
    try {
        const venda = await provisionamentoService.criarVenda(req.body);
        res.status(201).json({
            success: true,
            message: 'Venda criada e custos calculados',
            data: venda
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Registrar realização de sessão (provisiona receita)
router.post('/sessao-realizada/:sessionId', auth, async (req, res) => {
    try {
        const { dataRealizacao } = req.body;
        const resultado = await provisionamentoService.realizarSessao(
            req.params.sessionId,
            dataRealizacao ? new Date(dataRealizacao) : new Date()
        );

        res.json({
            success: true,
            message: 'Sessão provisionada com sucesso',
            data: resultado
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Relatório analítico completo (igual planilha)
router.get('/relatorio/analitico', auth, authorize(['admin']), async (req, res) => {
    try {
        const { month, year } = req.query;

        if (!month || !year) {
            return res.status(400).json({
                success: false,
                message: 'Informe month e year'
            });
        }

        const dados = await provisionamentoService.gerarRelatorioAnalitico(
            parseInt(month),
            parseInt(year)
        );

        res.json({
            success: true,
            data: dados
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Exportar Excel
router.get('/export/excel', auth, authorize(['admin']), async (req, res) => {
    try {
        const { month, year } = req.query;
        const dados = await provisionamentoService.exportarExcel(
            parseInt(month),
            parseInt(year)
        );

        // Configurar headers para download
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=provisionamento_${year}_${month}.xlsx`);

        // Aqui você usaria uma lib como exceljs para gerar o buffer
        // const buffer = await gerarExcelBuffer(dados);
        // res.send(buffer);

        res.json({ success: true, dados }); // Temporário até implementar geração real
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Dashboard resumido
router.get('/dashboard', auth, async (req, res) => {
    try {
        const { month, year } = req.query;
        const hoje = new Date();
        const mes = month ? parseInt(month) : hoje.getMonth() + 1;
        const ano = year ? parseInt(year) : hoje.getFullYear();

        const dados = await provisionamentoService.gerarRelatorioAnalitico(mes, ano);

        res.json({
            success: true,
            data: {
                indicadores: dados.dashboard,
                pacotesAndamento: dados.pacotesAndamento.length,
                faturamentoMesAtual: dados.faturamentoMes.find(m =>
                    m.Mes === moment().month(mes - 1).format('MMMM')
                )
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

export default router;