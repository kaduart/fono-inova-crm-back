/**
 * syncAffectedViews
 *
 * Ponto único de sincronização entre mutations e projections/views.
 *
 * USO:
 *   await syncAffectedViews({
 *     event: 'appointment.updated',
 *     packageId,       // se presente → rebuild PackagesView
 *     patientId,       // futuro: rebuild PatientsView
 *     correlationId
 *   });
 *
 * ADICIONAR NOVA PROJEÇÃO:
 *   1. Adicionar handler em PROJECTION_HANDLERS
 *   2. Adicionar evento → handler em PROJECTION_REGISTRY
 *
 * NUNCA chamar buildPackageView diretamente nos routes.
 */

// ─── HANDLERS (um por projeção) ──────────────────────────────────────────────

const PROJECTION_HANDLERS = {
  /**
   * PackagesView — projeção operacional crítica.
   * Alimenta package screen, calendar, edição, métricas.
   */
  packages: async ({ packageId, correlationId }) => {
    if (!packageId) return;
    const { buildPackageView } = await import(
      '../../domains/billing/services/PackageProjectionService.js'
    );
    await buildPackageView(packageId.toString(), { correlationId, force: true });
  },

  // futuro: adicionar handlers para outras projeções aqui
  // patients: async ({ patientId, correlationId }) => { ... },
  // financialDashboard: async ({ correlationId }) => { ... },
};

// ─── REGISTRY (evento → lista de handlers) ───────────────────────────────────

const PROJECTION_REGISTRY = {
  // Domínio: Scheduling × TherapyPackage
  'appointment.updated':              ['packages'],
  'appointment.cancelled':            ['packages'],
  'appointment.completed':            ['packages'],
  'appointment.confirmed':            ['packages'],
  'appointment.rescheduled':          ['packages'],
  'appointment.deleted':              ['packages'],
  'appointment.reverted':             ['packages'],

  // Domínio: Financial × TherapyPackage (fechamento de sessões pós-pagas de pacote)
  'therapy_package.payment_settled':  ['packages'],

  // NÃO adicionar eventos genéricos de payment aqui.
  // 'payment.updated' pertence ao domínio Financial, não ao TherapyPackage.
  // Ver: docs/architecture/bounded-contexts.md
};

// ─── FUNÇÃO PÚBLICA ───────────────────────────────────────────────────────────

/**
 * Sincroniza todas as projeções afetadas por um evento de mutation.
 *
 * Usa Promise.allSettled — falha em uma projeção não bloqueia as outras.
 * Erros são logados mas nunca propagados (não quebram o response ao cliente).
 *
 * @param {Object} ctx
 * @param {string} ctx.event        - Tipo do evento (ver PROJECTION_REGISTRY)
 * @param {string} [ctx.packageId]  - ID do pacote afetado
 * @param {string} [ctx.patientId]  - ID do paciente afetado (futuro)
 * @param {string} [ctx.correlationId]
 */
export async function syncAffectedViews({ event, packageId, patientId, correlationId } = {}) {
  const handlerNames = PROJECTION_REGISTRY[event];

  if (!handlerNames?.length) {
    console.warn(`[syncAffectedViews] Evento sem handlers registrados: "${event}"`);
    return;
  }

  const ctx = { packageId, patientId, correlationId };

  const results = await Promise.allSettled(
    handlerNames.map(name => {
      const handler = PROJECTION_HANDLERS[name];
      if (!handler) {
        console.warn(`[syncAffectedViews] Handler não encontrado: "${name}"`);
        return Promise.resolve();
      }
      return handler(ctx);
    })
  );

  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      console.error(
        `[syncAffectedViews] Falha no handler "${handlerNames[i]}" (evento: ${event}):`,
        result.reason?.message
      );
    }
  });
}
