import ejs from 'ejs';
import path from 'path';
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'url';

// Para resolver __dirname em módulo ES
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function generatePdfFromTemplate(data, templateName) {
    try {
        const templatePath = path.join(__dirname, '../templates', `${templateName}.ejs`);
        const html = await ejs.renderFile(templatePath, { data });

        const browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
        const pdfBuffer = await page.pdf({ format: 'A4' });

        await browser.close();
        return pdfBuffer;
    } catch (error) {
        throw new Error(`Erro ao gerar PDF do template ${templateName}: ${error.message}`);
    }
}

export async function generatePdfFromEvolution(evolution) {
    try {
        // Caminho do template HTML
        const templatePath = path.join(__dirname, '../templates/evolutionPdfTemplate.ejs');

        // Renderiza o HTML com os dados da evolução
        const html = await ejs.renderFile(templatePath, { evolution });

        const browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
        const pdfBuffer = await page.pdf({ format: 'A4' });

        await browser.close();
        return pdfBuffer;
    } catch (error) {
        throw new Error(`Erro ao gerar PDF: ${error.message}`);
    }
}

