/**
 * Verifica status do webhook no Meta
 */

import dotenv from 'dotenv';
dotenv.config();

const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

async function verificarWebhook() {
    console.log('🔍 Verificando webhook no Meta...\n');
    
    if (!TOKEN || !PHONE_NUMBER_ID) {
        console.log('❌ Variáveis ausentes:');
        console.log('   WHATSAPP_ACCESS_TOKEN:', TOKEN ? '***' : 'NÃO CONFIGURADO');
        console.log('   WHATSAPP_PHONE_NUMBER_ID:', PHONE_NUMBER_ID || 'NÃO CONFIGURADO');
        return;
    }

    try {
        // 1. Verifica subscriptions
        const subsRes = await fetch(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/subscribed_apps?access_token=${TOKEN}`);
        const subs = await subsRes.json();
        
        console.log('📋 Subscriptions:');
        console.log(JSON.stringify(subs, null, 2));
        
        // 2. Verifica configuração do webhook
        const configRes = await fetch(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}?fields=webhook_configuration&access_token=${TOKEN}`);
        const config = await configRes.json();
        
        console.log('\n⚙️ Webhook Configuration:');
        console.log(JSON.stringify(config, null, 2));
        
    } catch (err) {
        console.error('❌ Erro:', err.message);
    }
}

verificarWebhook();
