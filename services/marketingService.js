// services/marketingService.js
const mockAdsData = [
    {
        campaign: { id: "1", name: "Campanha Teste 1" },
        metrics: { clicks: 120, impressions: 2000, conversions: 10, cost_micros: 5000000 }
    },
    {
        campaign: { id: "2", name: "Campanha Teste 2" },
        metrics: { clicks: 80, impressions: 1500, conversions: 5, cost_micros: 3000000 }
    },
];

const mockAnalyticsData = [
    { action: "click_button", category: "CTA", label: "Homepage", timestamp: Date.now(), value: 1 },
    { action: "view_page", category: "PageView", label: "Pricing", timestamp: Date.now(), value: 1 },
];

const mockPerformanceData = {
    byStatus: [
        { date: "2025-09-01", clicks: 50, impressions: 500, conversions: 2 },
        { date: "2025-09-02", clicks: 70, impressions: 700, conversions: 5 },
    ],
    byOrigin: []
};

export default {
    getGoogleAdsCampaigns: async () => mockAdsData,
    getSiteAnalytics: async () => mockAnalyticsData,
    getPerformanceOverTime: async () => mockPerformanceData,
};
