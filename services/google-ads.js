import dotenv from 'dotenv';
import { GoogleAdsApi } from 'google-ads-api';
dotenv.config();

export const client = new GoogleAdsApi({
  client_id: process.env.GOOGLE_ADS_CLIENT_ID,
  client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
  developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
});

export const customer = client.Customer({
  customer_id: process.env.GOOGLE_ADS_CUSTOMER_ID,
  refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
});

// Função para pegar campanhas
export const getCampaigns = async () => {
  return customer.query(`
    SELECT
      campaign.id,
      campaign.name,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros
    FROM campaign
    WHERE segments.date DURING LAST_30_DAYS
  `);
};

// Função para pegar anúncios
export const getAds = async () => {
  return customer.query(`
    SELECT
      ad_group_ad.ad.id,
      ad_group_ad.ad.name,
      metrics.impressions,
      metrics.clicks,
      metrics.ctr
    FROM ad_group_ad
    WHERE segments.date DURING LAST_30_DAYS
  `);
};
