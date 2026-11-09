import dotenv from 'dotenv';
dotenv.config();

// 09/11/2026 (incidente RSS 93% na API do Render): 'google-ads-api' custa ~100 MB de
// heap / ~170 MB de RSS só para ser importado, e este arquivo era carregado no boot
// (routes/google-ads.js). Agora a lib só é carregada na 1ª chamada de getCampaigns/getAds.
let customerPromise = null;

async function getCustomer() {
    if (customerPromise) return customerPromise;
    const {
        GOOGLE_ADS_CLIENT_ID,
        GOOGLE_ADS_CLIENT_SECRET,
        GOOGLE_ADS_REFRESH_TOKEN,
        GOOGLE_ADS_DEVELOPER_TOKEN,
        GOOGLE_ADS_CUSTOMER_ID
    } = process.env;

    // 🔹 Valida variáveis de ambiente
    if (!GOOGLE_ADS_CLIENT_ID || !GOOGLE_ADS_CLIENT_SECRET || !GOOGLE_ADS_REFRESH_TOKEN || !GOOGLE_ADS_DEVELOPER_TOKEN || !GOOGLE_ADS_CUSTOMER_ID) {
        throw new Error('❌ Verifique todas as variáveis de ambiente do Google Ads. Alguma está faltando.');
    }

    customerPromise = import('google-ads-api')
        .then(({ GoogleAdsApi }) => {
            // 🔹 Inicializa cliente
            const client = new GoogleAdsApi({
                client_id: GOOGLE_ADS_CLIENT_ID,
                client_secret: GOOGLE_ADS_CLIENT_SECRET,
                developer_token: GOOGLE_ADS_DEVELOPER_TOKEN,
            });
            return client.Customer({
                customer_account_id: GOOGLE_ADS_CUSTOMER_ID,
                refresh_token: GOOGLE_ADS_REFRESH_TOKEN,
            });
        })
        .catch((err) => {
            customerPromise = null; // permite nova tentativa
            throw err;
        });
    return customerPromise;
}

// ============================
// Funções para consultar dados
// ============================
export async function getCampaigns() {
    const customer = await getCustomer();
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
        const customer = await getCustomer();
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
