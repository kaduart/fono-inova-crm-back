// services/notificationService.ts
import axios from 'axios';

export const sendPushNotification = async ({
    token,
    title,
    body,
    data
}: {
    token: string;
    title: string;
    body: string;
    data?: Record<string, any>;
}) => {
    try {
        await axios.post(
            'https://fcm.googleapis.com/fcm/send',
            {
                to: token,
                notification: { title, body },
                data
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `key=${process.env.FIREBASE_SERVER_KEY}`
                }
            }
        );
    } catch (error) {
        console.error('Erro no envio de push notification:', error);
        throw error;
    }
};