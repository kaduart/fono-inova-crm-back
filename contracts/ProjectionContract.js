/**
 * Projection Contract System
 * 
 * Padroniza como projeções (views) são criadas no sistema.
 * Evita bugs de ID inconsistente entre aggregate roots e suas projeções.
 * 
 * Tipos de Projeção:
 * - ONE_TO_ONE_VIEW: Projeção 1:1 do mesmo aggregate (ex: PatientView)
 * - ONE_TO_MANY_VIEW: Projeção agregada (ex: PatientHistory, DashboardStats)
 * - EVENT_VIEW: Event sourcing/audit log
 * - SNAPSHOT_VIEW: Snapshot versionado
 * 
 * Estratégia de ID:
 * - SHARED: _id da view = _id do aggregate source (1:1 views)
 * - GENERATED: _id próprio gerado pelo Mongo (histórico, snapshots)
 */

export const ProjectionType = {
  ONE_TO_ONE_VIEW: 'ONE_TO_ONE_VIEW',      // Ex: PatientView
  ONE_TO_MANY_VIEW: 'ONE_TO_MANY_VIEW',    // Ex: DashboardStats
  EVENT_VIEW: 'EVENT_VIEW',                // Ex: AuditLog, EventStore
  SNAPSHOT_VIEW: 'SNAPSHOT_VIEW'           // Ex: MonthlyReports
};

export const IdentityStrategy = {
  SHARED: 'SHARED',       // Mesmo ID do source
  GENERATED: 'GENERATED'  // ID próprio
};

/**
 * Contrato base para todas as projeções
 */
export class ProjectionContract {
  constructor({
    type,
    sourceAggregate,
    identityStrategy,
    collectionName,
    mongooseModel
  }) {
    this.type = type;
    this.sourceAggregate = sourceAggregate;
    this.identityStrategy = identityStrategy;
    this.collectionName = collectionName;
    this.mongooseModel = mongooseModel;

    this.validate();
  }

  validate() {
    if (!Object.values(ProjectionType).includes(this.type)) {
      throw new Error(`Tipo de projeção inválido: ${this.type}`);
    }
    if (!Object.values(IdentityStrategy).includes(this.identityStrategy)) {
      throw new Error(`Estratégia de ID inválida: ${this.identityStrategy}`);
    }
    if (!this.sourceAggregate) {
      throw new Error('sourceAggregate é obrigatório');
    }
  }

  /**
   * Determina o _id correto baseado na estratégia
   */
  resolveId(sourceEntity) {
    if (this.identityStrategy === IdentityStrategy.SHARED) {
      // 1:1 view - usa o mesmo ID do source
      return sourceEntity._id;
    }
    // Views com lifecycle próprio geram ID novo
    return undefined; // Mongo gera automaticamente
  }

  /**
   * Verifica se a projeção deve ter o mesmo ID do source
   */
  isSharedIdentity() {
    return this.identityStrategy === IdentityStrategy.SHARED;
  }
}

/**
 * Contrato específico para PatientView (1:1)
 */
export const PatientViewContract = new ProjectionContract({
  type: ProjectionType.ONE_TO_ONE_VIEW,
  sourceAggregate: 'Patient',
  identityStrategy: IdentityStrategy.SHARED,
  collectionName: 'patients_view',
  mongooseModel: 'PatientsView'
});

/**
 * Contrato para histórico de paciente (1:N - cada mudança é um registro)
 */
export const PatientHistoryContract = new ProjectionContract({
  type: ProjectionType.EVENT_VIEW,
  sourceAggregate: 'Patient',
  identityStrategy: IdentityStrategy.GENERATED,
  collectionName: 'patient_history',
  mongooseModel: 'PatientHistory'
});

/**
 * Registry de contratos - centraliza todas as projeções do sistema
 */
export class ProjectionRegistry {
  constructor() {
    this.contracts = new Map();
  }

  register(name, contract) {
    this.contracts.set(name, contract);
  }

  get(name) {
    return this.contracts.get(name);
  }

  getAll() {
    return Array.from(this.contracts.entries());
  }

  /**
   * Valida se uma projeção segue o contrato correto
   */
  validateProjection(name, data) {
    const contract = this.get(name);
    if (!contract) {
      throw new Error(`Contrato não encontrado: ${name}`);
    }

    // Se for SHARED identity, _id DEVE ser igual ao source._id
    if (contract.isSharedIdentity() && data.sourceId) {
      if (data._id?.toString() !== data.sourceId?.toString()) {
        throw new Error(
          `Violação de contrato ${name}: _id (${data._id}) !== sourceId (${data.sourceId}) ` +
          `para projeção 1:1`
        );
      }
    }

    return true;
  }
}

// Instância global do registry
export const projectionRegistry = new ProjectionRegistry();
projectionRegistry.register('PatientView', PatientViewContract);
projectionRegistry.register('PatientHistory', PatientHistoryContract);

export default ProjectionContract;
