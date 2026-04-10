/**
 * Contracts Module
 * 
 * Exporta todos os contratos do sistema para garantir consistência
 * arquitetural entre diferentes módulos.
 */

export {
  ProjectionContract,
  ProjectionType,
  IdentityStrategy,
  PatientViewContract,
  PatientHistoryContract,
  ProjectionRegistry,
  projectionRegistry
} from './ProjectionContract.js';

export { default } from './ProjectionContract.js';
