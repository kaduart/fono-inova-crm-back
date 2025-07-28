
// src/services/appointmentService.ts
import {
    AppointmentStatus,
    IAppointmentResponse,
    IPaginatedAppointmentResponse,
    TherapyType
} from '../utils/types/types';
import API from './api';

export interface StatusConfig {
    [key: string]: {
        backgroundColor: string;
        textColor: string;
        label: string;
    };
}
export const OPERATIONAL_STATUS_CONFIG: StatusConfig = {
    agendado: {
        backgroundColor: '#4CAF50', // Verde
        textColor: '#FFFFFF',
        label: 'Agendado'
    },
    confirmado: {
        backgroundColor: '#2196F3', // Azul
        textColor: '#FFFFFF',
        label: 'Confirmado'
    },
    cancelado: {
        backgroundColor: '#F44336', // Vermelho
        textColor: '#FFFFFF',
        label: 'Cancelado'
    },
    pago: {
        backgroundColor: '#9C27B0', // Roxo
        textColor: '#FFFFFF',
        label: 'Pago'
    },
    faltou: {
        backgroundColor: '#FF9800', // Laranja
        textColor: '#FFFFFF',
        label: 'Faltou'
    }
};

let customStatusConfig: Partial<StatusConfig> = {};

export const setCustomStatusConfig = (config: Partial<StatusConfig>) => {
  customStatusConfig = config;
};

export const getStatusConfig = (status: string) => {
  if (!status) return fallbackConfig('indefinido');

  // 1. Verifica se existe uma configuração personalizada
  if (customStatusConfig[status]) return customStatusConfig[status]!;

  // 2. Verifica se existe no padrão operacional
  if (OPERATIONAL_STATUS_CONFIG[status]) return OPERATIONAL_STATUS_CONFIG[status]!;

  // 3. Fallback padrão para status desconhecido
  return fallbackConfig(status);
};

// Função auxiliar para retorno padrão
const fallbackConfig = (status: string) => ({
  backgroundColor: '#CCCCCC',
  textColor: '#000000',
  label: status?.charAt(0).toUpperCase() + status?.slice(1)
});
