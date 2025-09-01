import { google } from "googleapis";

const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_ADS_CLIENT_ID,
    process.env.GOOGLE_ADS_CLIENT_SECRET,
    process.env.GOOGLE_ADS_REDIRECT_URI
);

oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
});

export const getAccessTokenGoogle = async () => {
    const { token } = await oauth2Client.getAccessToken();
    return token;
};
