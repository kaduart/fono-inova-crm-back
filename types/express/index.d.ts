// Deixe isso para que o arquivo seja tratado como módulo externo
export {};

import * as express from 'express';

declare global {
    namespace Express {
        interface Request {
            user?: {
                id: string;
                role: string;
                // qualquer outra propriedade que você armazena no token
            };
        }
    }
}
