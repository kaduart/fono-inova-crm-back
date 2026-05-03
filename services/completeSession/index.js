// completeSession/index.js
// Dispatcher — orquestra handlers por billingType.
//
// Estado atual (strangler em progresso):
//   convenio   → ConvenioHandler   (extraído ✅)
//   liminar    → LiminarHandler    (extraído ✅)
//   particular → ParticularHandler (extraído ✅)
//   package    → legado inline
//
// O orquestrador principal ainda vive em completeSessionService.v2.js.
// Este arquivo centraliza os imports dos handlers extraídos.

export { ConvenioHandler }   from './handlers/convenioHandler.js';
export { LiminarHandler }    from './handlers/liminarHandler.js';
export { ParticularHandler } from './handlers/particularHandler.js';
export { buildCompleteContext } from './shared/context.js';
