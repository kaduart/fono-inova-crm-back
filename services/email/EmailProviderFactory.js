// services/email/EmailProviderFactory.js
import { ResendProvider } from './providers/ResendProvider.js';
import { SMTPProvider } from './providers/SMTPProvider.js';

const PROVIDERS = {
  resend: ResendProvider,
  smtp: SMTPProvider,
  mailjet: SMTPProvider
};

export function getEmailProvider() {
  const providerName = (process.env.EMAIL_PROVIDER || 'smtp').toLowerCase();
  const ProviderClass = PROVIDERS[providerName] || SMTPProvider;
  return new ProviderClass();
}

export { ResendProvider, SMTPProvider };
export default getEmailProvider;
