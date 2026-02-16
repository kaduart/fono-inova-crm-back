// tests/mocks/leads.mock.js
import { vi } from 'vitest';

// Mock básico do paciente
export const mockPatient = {
    findById: vi.fn().mockImplementation((id) => ({
        lean: vi.fn().mockResolvedValue({
            _id: id,
            name: 'Paciente Teste',
            birthDate: '2010-01-01',
            phone: '11999999999',
            history: [],
            primaryComplaint: undefined,
            multipleChildren: false,
            waiveRescheduleFee: false,
        }),
    })),
    findOne: vi.fn().mockImplementation((query) => ({
        lean: vi.fn().mockResolvedValue({
            _id: query._id || 'mock-id',
            name: 'Paciente Teste',
            birthDate: '2010-01-01',
            phone: '11999999999',
            history: [],
            primaryComplaint: undefined,
            multipleChildren: false,
            waiveRescheduleFee: false,
        }),
    })),
    create: vi.fn().mockImplementation((data) => Promise.resolve({
        _id: 'mock-id',
        ...data,
    })),
    findOneAndUpdate: vi.fn().mockImplementation((query, update) => ({
        lean: vi.fn().mockResolvedValue({
            _id: query._id || 'mock-id',
            ...update,
            name: 'Paciente Teste',
            history: [],
            primaryComplaint: undefined,
            multipleChildren: false,
            waiveRescheduleFee: false,
        }),
    })),
};

// Campos extras que o Leads/Orchestrator pode precisar
const mockExtraFields = {
    name: 'Paciente Teste',
    history: [],
    primaryComplaint: undefined,
    multipleChildren: false,
    waiveRescheduleFee: false,
    therapies: [],           // 👈 necessário para detectAllTherapies
    scheduledAppointments: [],
};

// Mock do Leads
export const LeadsMock = {
    findByIdAndUpdate: vi.fn().mockImplementation((id, update) => ({
        lean: vi.fn().mockResolvedValue({
            _id: id,
            ...mockExtraFields,
            ...update,
        }),
    })),


    findOne: vi.fn().mockImplementation((query) => ({
        lean: vi.fn().mockResolvedValue({
            _id: query._id || 'mock-id',
            ...mockExtraFields,
        }),
    })),

    create: vi.fn().mockResolvedValue({
        _id: 'mock-id',
        ...mockExtraFields,
    }),

    findOneAndUpdate: vi.fn().mockImplementation((query, update) => ({
        lean: vi.fn().mockResolvedValue({
            _id: query._id || 'mock-id',
            ...mockExtraFields,
            ...update,
        }),
    })),
};

// Substitui os imports reais pelos mocks
vi.mock('../../models/Leads', () => ({
    default: LeadsMock,
}));

vi.mock('../../models/Patient.js', () => ({
    default: mockPatient,
}));
