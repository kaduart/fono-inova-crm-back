import dotenv from 'dotenv';
import { GoogleAdsApi } from 'google-ads-api';
dotenv.config();

// 🔹 Valida variáveis de ambiente
const {
    GOOGLE_ADS_CLIENT_ID,
    GOOGLE_ADS_CLIENT_SECRET,
    GOOGLE_ADS_REFRESH_TOKEN,
    GOOGLE_ADS_DEVELOPER_TOKEN,
    GOOGLE_ADS_CUSTOMER_ID
} = process.env;

if (!GOOGLE_ADS_CLIENT_ID || !GOOGLE_ADS_CLIENT_SECRET || !GOOGLE_ADS_REFRESH_TOKEN || !GOOGLE_ADS_DEVELOPER_TOKEN || !GOOGLE_ADS_CUSTOMER_ID) {
    throw new Error('❌ Verifique todas as variáveis de ambiente do Google Ads. Alguma está faltando.');
}

// 🔹 Inicializa cliente
const client = new GoogleAdsApi({
    client_id: GOOGLE_ADS_CLIENT_ID,
    client_secret: GOOGLE_ADS_CLIENT_SECRET,
    developer_token: GOOGLE_ADS_DEVELOPER_TOKEN,
})

const customer = client.Customer({
    customer_account_id: GOOGLE_ADS_CUSTOMER_ID,
    refresh_token: GOOGLE_ADS_REFRESH_TOKEN,
});

// ============================
// Funções para consultar dados
// ============================
export async function getCampaigns() {
    const campaigns = await customer.query(`
    SELECT
      campaign.id,
      campaign.name,
      campaign.status
    FROM campaign
    ORDER BY campaign.id
    LIMIT 10
  `);

    return campaigns.map(c => ({
        id: c.campaign.id,
        name: c.campaign.name,
        status: c.campaign.status
    }));
}


export async function getAds() {
    try {
        const ads = await customer.query(`
      SELECT
        ad_group_ad.ad.id,
        ad_group_ad.ad.name,
        ad_group_ad.status
      FROM ad_group_ad
      ORDER BY ad_group_ad.ad.id
    `);
        return ads;
    } catch (err) {
        console.error('Erro ao buscar anúncios:', err);
        throw err;
    }
}
