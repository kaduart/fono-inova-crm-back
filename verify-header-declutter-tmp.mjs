import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();
await mongoose.connect(process.env.MONGO_URI);
const jwt = (await import('jsonwebtoken')).default;
const token = jwt.sign({ id: '69d9465aa7175249d0b1c879', role: 'admin', name: 'Admin' }, process.env.JWT_SECRET || 'secreta', { expiresIn: '2h' });
await mongoose.disconnect();

const puppeteer = (await import('puppeteer-core')).default;
const USER = {
  _id: '69d9465aa7175249d0b1c879', fullName: 'Admin', email: 'admin@fonoinova.com.br',
  active: true, role: 'admin', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};
const PATIENT_ID = '69fa39ce003164e56ab87c55';

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium-browser', headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox']
});
const page = await browser.newPage();
const consoleErrors = [];
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
page.on('pageerror', (err) => consoleErrors.push(`[pageerror] ${err.message}`));

await page.goto('http://localhost:5173/login', { waitUntil: 'networkidle2', timeout: 20000 });
await page.evaluate((t, u) => {
  localStorage.setItem('token', t);
  localStorage.setItem('user', JSON.stringify(u));
  localStorage.setItem('userRole', JSON.stringify('admin'));
  localStorage.setItem('lastActivity', Date.now().toString());
  localStorage.setItem('authValidatedAt', Date.now().toString());
}, token, USER);

await page.goto(`http://localhost:5173/patient-dashboard/${PATIENT_ID}`, { waitUntil: 'networkidle2', timeout: 30000 });
await new Promise(r => setTimeout(r, 2000));
await page.evaluate(() => {
  const els = Array.from(document.querySelectorAll('button, [role="tab"], a, div'))
    .filter(el => /liminar/i.test(el.textContent || '') && el.textContent.length < 60);
  if (els.length > 0) els[0].click();
});
await new Promise(r => setTimeout(r, 1500));
await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll('button')).filter(b => /Ver plano terap/i.test(b.textContent || ''));
  if (btns.length > 0) btns[0].click();
});
await new Promise(r => setTimeout(r, 1000));

const bodyText1 = await page.evaluate(() => document.body.innerText);
console.log('Contém "Horários" (trigger novo)?', (bodyText1.match(/\bHorários\b/g) || []).length, 'ocorrências');
console.log('Sex 14:40 visível ANTES de clicar (deveria ser false)?', bodyText1.includes('Sex 14:40'));

const clicked = await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll('button')).filter(b => b.textContent?.trim().startsWith('Horários'));
  if (btns.length > 0) { btns[0].click(); return btns.length; }
  return 0;
});
console.log('Botões "Horários" encontrados e clicados:', clicked);
await new Promise(r => setTimeout(r, 500));

const bodyText2 = await page.evaluate(() => document.body.innerText);
console.log('Sex 14:40 visível DEPOIS de clicar?', bodyText2.includes('Sex 14:40'));

await page.screenshot({ path: '/tmp/claude-1000/-home-user-projetos-crm/aafbb13e-7dee-4078-9ba8-cefd759b127e/scratchpad/header_declutter.png', fullPage: true });

console.log('\nErros de console relevantes:', consoleErrors.filter(e => !/401|404|admin profile|future sessions/i.test(e)));

await browser.close();
