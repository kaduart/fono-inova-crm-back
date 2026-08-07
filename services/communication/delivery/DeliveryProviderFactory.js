// services/communication/delivery/DeliveryProviderFactory.js
//
// Factory de providers de entrega para InsuranceCommunication.
//
// O módulo de comunicação foi projetado como uma abstração unificada
// (InsuranceCommunication + CommunicationPackage). Esta factory completa a
// abstração: o "como" entregar fica isolado em providers, e o orquestrador
// (CommunicationService) apenas escolhe o canal e coordena o estado.
//
// Canais suportados:
//   - email:    envio via Resend usando fila BullMQ (comportamento legado)
//   - external: registro de envio realizado fora da aplicação (portal, Outlook, etc.)
//   - portal:   reservado para integrações futuras
//
// Adicionar um novo canal não exige alterar CommunicationService nem a state
// machine — basta implementar a interface de DeliveryProvider e registrá-lo aqui.

import { EmailDeliveryProvider } from './EmailDeliveryProvider.js';
import { ExternalDeliveryProvider } from './ExternalDeliveryProvider.js';

const PROVIDERS = {
  email: EmailDeliveryProvider,
  external: ExternalDeliveryProvider
  // portal: PortalDeliveryProvider (futuro)
};

export const DELIVERY_CHANNELS = Object.keys(PROVIDERS);

export function resolveProvider(method) {
  const normalized = String(method || 'email').toLowerCase().trim();
  const ProviderClass = PROVIDERS[normalized];

  if (!ProviderClass) {
    throw new Error(`DELIVERY_METHOD_NOT_SUPPORTED: ${method}`);
  }

  return new ProviderClass();
}

export function isDeliveryMethodSupported(method) {
  const normalized = String(method || 'email').toLowerCase().trim();
  return PROVIDERS.hasOwnProperty(normalized);
}

export function getDefaultDeliveryMethod() {
  return 'email';
}
