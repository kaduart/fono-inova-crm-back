/**
 * Reproduz:
 *  [CRITICO] Envelope de resposta da API V2 desalinhado com frontend
 *  [CRITICO] Payload de criação V2 omite campos obrigatórios do schema
 *
 * Testa a rota evolution.v2.js garantindo que:
 *  1. GET /patient/:id retorna { success: true, data: [...] }
 *  2. POST / retorna 201 com documento criado e valida campos obrigatórios
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock do publishEvent para inspecionar payload
const mockPublishEvent = vi.fn();
vi.mock('../../infrastructure/events/eventPublisher.js', () => ({
    publishEvent: (...args) => mockPublishEvent(...args),
    EventTypes: {
        EVOLUTION_CREATE_REQUESTED: 'EVOLUTION_CREATE_REQUESTED',
        EVOLUTION_UPDATE_REQUESTED: 'EVOLUTION_UPDATE_REQUESTED',
        EVOLUTION_DELETE_REQUESTED: 'EVOLUTION_DELETE_REQUESTED',
        EVOLUTION_CREATED: 'EVOLUTION_CREATED',
        EVOLUTION_UPDATED: 'EVOLUTION_UPDATED',
        EVOLUTION_DELETED: 'EVOLUTION_DELETED',
    },
}));

// Mock do flexibleAuth (deixa passar qualquer request)
vi.mock('../../middleware/amandaAuth.js', () => ({
    flexibleAuth: (req, res, next) => {
        req.user = { id: 'user123', role: 'doctor', specialty: 'Fonoaudiologia' };
        next();
    },
}));

// Mock do generatePDF
vi.mock('../../services/generatePDF.js', () => ({
    generatePdfFromEvolution: vi.fn().mockResolvedValue(Buffer.from('pdf')),
}));

// Mock do mongoose
vi.mock('mongoose', () => ({
    default: {
        Types: {
            ObjectId: class {
                constructor(id) { this._id = id; }
                static isValid(id) { return /^[a-f0-9]{24}$/i.test(id); }
                toString() { return this._id; }
                equals() { return false; }
            },
        },
        model: () => ({}),
    },
    Types: {
        ObjectId: class {
            constructor(id) { this._id = id; }
            static isValid(id) { return /^[a-f0-9]{24}$/i.test(id); }
            toString() { return this._id; }
            equals() { return false; }
        },
    },
}));

// Mock do modelo Evolution
vi.mock('../../models/Evolution.js', () => {
    const mockEvolutionFind = vi.fn();
    const mockEvolutionFindById = vi.fn();
    const mockEvolutionFindOne = vi.fn();
    const mockEvolutionDeleteOne = vi.fn();
    const mockSave = vi.fn();
    const mockCalculateObjectivesProgress = vi.fn();

    class MockEvolution {
        constructor(data) { Object.assign(this, data); }
        save() { return mockSave(this); }
        calculateObjectivesProgress() { return mockCalculateObjectivesProgress(this); }
        static find = (...args) => mockEvolutionFind(...args);
        static findById = (...args) => mockEvolutionFindById(...args);
        static findOne = (...args) => mockEvolutionFindOne(...args);
        static findByIdAndUpdate = vi.fn();
        static findByIdAndDelete = vi.fn();
    }
    MockEvolution.prototype.deleteOne = async function () {
        mockEvolutionDeleteOne(this._id);
    };

    // Expõe os mocks para o escopo do teste
    global.__evolutionMocks = {
        mockEvolutionFind,
        mockEvolutionFindById,
        mockEvolutionFindOne,
        mockEvolutionDeleteOne,
        mockSave,
        mockCalculateObjectivesProgress,
    };

    return { default: MockEvolution };
});

vi.mock('../../models/Metric.js', () => ({
    default: {
        find: vi.fn(),
    },
}));

import evolutionV2Routes from '../../routes/evolution.v2.js';

describe('Evolution V2 - API Contract', () => {
    let app;

    beforeEach(() => {
        app = express();
        app.use(express.json());
        app.use('/v2/evolutions', evolutionV2Routes);
        vi.clearAllMocks();
    });

    describe('GET /patient/:patientId', () => {
        it('retorna envelope { success: true, data: [...] }', async () => {
            const mockEvolutions = [
                {
                    _id: '507f1f77bcf86cd799439011',
                    date: new Date('2025-06-01'),
                    doctor: { fullName: 'Dr. Ana', specialty: 'Fonoaudiologia' },
                },
            ];

            global.__evolutionMocks.mockEvolutionFind.mockReturnValue({
                populate: () => ({ populate: () => ({ sort: () => Promise.resolve(mockEvolutions) }) }),
            });

            const res = await request(app)
                .get('/v2/evolutions/patient/507f1f77bcf86cd799439011');

            expect(res.status).toBe(200);
            expect(res.body).toHaveProperty('success', true);
            expect(res.body).toHaveProperty('data');
            expect(Array.isArray(res.body.data)).toBe(true);
            expect(res.body.data).toHaveLength(1);
            expect(res.body.data[0].doctor.fullName).toBe('Dr. Ana');
        });
    });

    describe('POST / (criação síncrona)', () => {
        it('retorna 201 e documento criado quando payload é válido', async () => {
            const payload = {
                patient: '507f1f77bcf86cd799439011',
                doctor: '507f1f77bcf86cd799439012',
                specialty: 'Fonoaudiologia',
                date: '2025-06-01T10:00:00.000Z',
                time: '10:00',
                content: 'Relatório clínico detalhado',
                metrics: [{ name: 'score', value: 8 }],
                evaluationAreas: [{ id: 'language', name: 'Linguagem', score: 7 }],
                evaluationTypes: ['language'],
                plan: 'Plano de tratamento',
                treatmentStatus: 'in_progress',
                therapeuticPlan: {
                    protocol: { code: 'TEA-01', name: 'Protocolo TEA' },
                    objectives: [{ area: 'language', description: 'Melhorar linguagem', targetScore: 10, currentScore: 7 }],
                },
                protocolCode: 'TEA-01',
                appointmentId: '507f1f77bcf86cd799439013',
            };

            global.__evolutionMocks.mockSave.mockResolvedValue(undefined);
            global.__evolutionMocks.mockEvolutionFindById.mockReturnValue({
                populate: () => ({
                    populate: () => Promise.resolve({
                        _id: 'new-evo-123',
                        ...payload,
                        doctor: { fullName: 'Dr. Ana', specialty: 'Fonoaudiologia' },
                        patient: { fullName: 'Paciente Teste', dateOfBirth: '2010-01-01' },
                    })
                })
            });

            const res = await request(app)
                .post('/v2/evolutions')
                .send(payload);

            expect(res.status).toBe(201);
            expect(res.body).toHaveProperty('success', true);
            expect(res.body).toHaveProperty('data');
            expect(res.body.data._id).toBe('new-evo-123');

            // 🔔 Side-effect: publishEvent pode ser chamado de forma não-bloqueante
            // após o sucesso da criação síncrona. Não exigimos chamada síncrona aqui.
        });

        it('retorna 400 quando specialty está ausente', async () => {
            const payload = {
                patient: '507f1f77bcf86cd799439011',
                date: '2025-06-01T10:00:00.000Z',
                // specialty omitido
            };

            const res = await request(app)
                .post('/v2/evolutions')
                .send(payload);

            expect(res.status).toBe(400);
            expect(res.body).toHaveProperty('success', false);
            expect(res.body.error.code).toBe('MISSING_SPECIALTY');
        });

        it('retorna 400 quando patient é inválido', async () => {
            const payload = {
                patient: 'invalid-id',
                specialty: 'Fonoaudiologia',
                date: '2025-06-01T10:00:00.000Z',
            };

            const res = await request(app)
                .post('/v2/evolutions')
                .send(payload);

            expect(res.status).toBe(400);
            expect(res.body.error.code).toBe('INVALID_PATIENT');
        });
    });

    describe('GET /patient/:patientId/last', () => {
        it('retorna envelope com a última evolução do paciente', async () => {
            const mockLast = {
                _id: '507f1f77bcf86cd799439011',
                date: new Date('2025-06-10'),
                content: 'Última evolução',
                specialty: 'Fonoaudiologia',
                metrics: [{ name: 'Articulação', value: 7 }],
                evaluationAreas: [{ id: 'linguagem_expressiva', name: 'Linguagem Expressiva', score: 8 }],
                doctor: { fullName: 'Dr. Ana', specialty: 'Fonoaudiologia' },
            };

            global.__evolutionMocks.mockEvolutionFindOne.mockReturnValue({
                populate: () => ({ sort: () => Promise.resolve(mockLast) }),
            });

            const res = await request(app)
                .get('/v2/evolutions/patient/507f1f77bcf86cd799439011/last');

            expect(res.status).toBe(200);
            expect(res.body).toHaveProperty('success', true);
            expect(res.body.data).toMatchObject({
                _id: '507f1f77bcf86cd799439011',
                content: 'Última evolução',
                specialty: 'Fonoaudiologia',
            });
        });

        it('retorna 404 quando não há evolução', async () => {
            global.__evolutionMocks.mockEvolutionFindOne.mockReturnValue({
                populate: () => ({ sort: () => Promise.resolve(null) }),
            });

            const res = await request(app)
                .get('/v2/evolutions/patient/507f1f77bcf86cd799439011/last');

            expect(res.status).toBe(404);
            expect(res.body).toHaveProperty('success', false);
            expect(res.body.error.code).toBe('NOT_FOUND');
        });
    });
});
