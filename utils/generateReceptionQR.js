import QRCode from "qrcode";

const payload = `
000201
26580014BR.GOV.BCB.PIX
01A6https://app.fonoinova.com.br/api/pix/checkout
52040000
5303986
540650.00
5802BR
5924CLINICA FONOINOVA
6009ANAPOLIS
62140510PIXGERAL
6304
`.replace(/\s+/g, ''); // remove quebras de linha

QRCode.toFile("qr-recepcao-fono.png", payload, {
  color: { dark: "#009739", light: "#ffffff" },
  width: 400,
  margin: 2,
}, (err) => {
  if (err) throw err;
  console.log("✅ QR Pix válido gerado: qr-recepcao-fono.png");
});
