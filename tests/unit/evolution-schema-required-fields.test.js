/**
 * Reproduz: [CRITICO] Worker V2 cria evoluções sem campos obrigatórios do schema
 *
 * O schema Evolution.js exige:
 *   - specialty: { required: true }
 *   - createdBy: { required: true }
 *
 * Como a rota V2 não propaga esses campos no evento, o worker também não os seta,
 * resultando em ValidationError e evolução nunca persistida.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import Evolution from '../../models/Evolution.js';

let mongoServer;

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
});

describe('Evolution Schema - Campos Obrigatórios', () => {
    it('deve rejeitar documento sem specialty (ValidationError)', async () => {
        const doc = new Evolution({
            patient: new mongoose.Types.ObjectId(),
            doctor: new mongoose.Types.ObjectId(),
            date: new Date(),
            createdBy: new mongoose.Types.ObjectId(),
            // specialty omitido intencionalmente
        });

        let error;
        try {
            await doc.validate();
        } catch (err) {
            error = err;
        }

        expect(error).toBeDefined();
        expect(error.name).toBe('ValidationError');
        expect(error.errors.specialty).toBeDefined();
    });

    it('deve rejeitar documento sem createdBy (ValidationError)', async () => {
        const doc = new Evolution({
            patient: new mongoose.Types.ObjectId(),
            doctor: new mongoose.Types.ObjectId(),
            date: new Date(),
            specialty: 'Fonoaudiologia',
            // createdBy omitido intencionalmente
        });

        let error;
        try {
            await doc.validate();
        } catch (err) {
            error = err;
        }

        expect(error).toBeDefined();
        expect(error.name).toBe('ValidationError');
        expect(error.errors.createdBy).toBeDefined();
    });

    it('deve aceitar documento completo com specialty e createdBy', async () => {
        const doc = new Evolution({
            patient: new mongoose.Types.ObjectId(),
            doctor: new mongoose.Types.ObjectId(),
            date: new Date(),
            specialty: 'Fonoaudiologia',
            createdBy: new mongoose.Types.ObjectId(),
            content: 'Relatório clínico',
            metrics: [{ name: 'score', value: 8 }],
            evaluationAreas: [{ id: 'language', name: 'Linguagem', score: 7 }],
            evaluationTypes: ['language'],
            therapeuticPlan: {
                protocol: { code: 'TEA-01', name: 'Protocolo TEA' },
                objectives: [{
                    area: 'language',
                    description: 'Melhorar linguagem',
                    targetScore: 10,
                    currentScore: 7,
                }],
            },
            activeProtocols: ['TEA-01'],
        });

        const err = await doc.validate().then(() => null, (e) => e);
        expect(err).toBeNull();
    });
});
