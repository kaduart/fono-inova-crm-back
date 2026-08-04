// services/email/EmailProviderFactory.js
import { ResendProvider } from './providers/ResendProvider.js';
import { SMTPProvider } from './providers/SMTPProvider.js';

const PROVIDERS = {
  resend: ResendProvider,
  smtp: SMTPProvider,
  mailjet: SMTPProvider
};

export function getEmailProviderName() {
  const providerName = (process.env.EMAIL_PROVIDER || 'smtp').toLowerCase();
  return PROVIDERS[providerName] ? providerName : 'smtp';
}

export function getEmailProvider() {
  const providerName = getEmailProviderName();
  const ProviderClass = PROVIDERS[providerName];
  return new ProviderClass();
}

export { ResendProvider, SMTPProvider };
export default getEmailProvider;
