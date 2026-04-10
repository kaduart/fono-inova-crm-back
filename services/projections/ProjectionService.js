/**
 * Projection Service
 * 
 * Serviço base para criar e gerenciar projeções (views) CQRS.
 * Garante que IDs sejam consistentes conforme o contrato da projeção.
 */

import { ProjectionRegistry, IdentityStrategy } from '../../contracts/ProjectionContract.js';

export class ProjectionService {
  constructor(contractOrName, model) {
    if (typeof contractOrName === 'string') {
      // Busca contrato pelo registry
      const registry = new ProjectionRegistry();
      this.contract = registry.get(contractOrName);
      if (!this.contract) {
        throw new Error(`Contrato não encontrado: ${contractOrName}`);
      }
    } else {
      this.contract = contractOrName;
    }
    
    this.model = model;
  }

  /**
   * Cria ou atualiza uma projeção garantindo ID correto
   */
  async upsert(sourceEntity, buildFn) {
    const projectionId = this.contract.resolveId(sourceEntity);
    
    // Monta os dados da projeção
    const projectionData = await buildFn(sourceEntity);
    
    // Garante o ID correto baseado no contrato
    if (this.contract.isSharedIdentity()) {
      projectionData._id = projectionId;
    }
    
    // Adiciona metadados de rastreabilidade
    projectionData._projectionMeta = {
      type: this.contract.type,
      sourceAggregate: this.contract.sourceAggregate,
      sourceId: sourceEntity._id,
      updatedAt: new Date()
    };

    // Upsert na collection
    const query = this.contract.isSharedIdentity() 
      ? { _id: projectionId }
      : { '_projectionMeta.sourceId': sourceEntity._id };

    const result = await this.model.findOneAndUpdate(
      query,
      projectionData,
      { upsert: true, new: true }
    );

    return result;
  }

  /**
   * Busca projeção pelo ID do source (funciona para SHARED e GENERATED)
   */
  async findBySourceId(sourceId) {
    if (this.contract.isSharedIdentity()) {
      return this.model.findById(sourceId);
    }
    
    return this.model.findOne({ '_projectionMeta.sourceId': sourceId });
  }

  /**
   * Remove projeção
   */
  async deleteBySourceId(sourceId) {
    if (this.contract.isSharedIdentity()) {
      return this.model.findByIdAndDelete(sourceId);
    }
    
    return this.model.deleteMany({ '_projectionMeta.sourceId': sourceId });
  }

  /**
   * Valida consistência da projeção
   */
  async validateConsistency(sourceId) {
    const projection = await this.findBySourceId(sourceId);
    
    if (!projection) {
      return { valid: false, error: 'Projeção não encontrada' };
    }

    if (this.contract.isSharedIdentity()) {
      if (projection._id.toString() !== sourceId.toString()) {
        return {
          valid: false,
          error: `ID inconsistente: projection._id (${projection._id}) !== sourceId (${sourceId})`,
          projection
        };
      }
    }

    return { valid: true, projection };
  }
}

export default ProjectionService;
