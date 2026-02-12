import mongoose from 'mongoose';
import moment from 'moment-timezone';
import { gerarRelatorioAnalitico } from './services/provisionamentoService.js';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

async function test() {
    try {
        console.log('--- TESTANDO PROVISIONAMENTO ANALÍTICO ---');
        await mongoose.connect(MONGO_URI);
        console.log('Conectado ao MongoDB');

        const mes = 2; // Fevereiro
        const ano = 2026;

        console.log(`Gerando relatório para ${mes}/${ano}...`);
        const dados = await gerarRelatorioAnalitico(mes, ano);

        console.log('Sucesso!');
        console.log('Chaves do objeto retornado:', Object.keys(dados));
        console.log('Tamanho da baseDados:', dados.baseDados?.length);

        if (!dados.baseDados) {
            console.error('ERRO: baseDados está UNDEFINED!');
        }

        process.exit(0);
    } catch (error) {
        console.error('ERRO NO TESTE:', error);
        process.exit(1);
    }
}

test();
