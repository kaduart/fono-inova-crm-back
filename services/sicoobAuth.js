import { execSync } from "child_process";
import dotenv from "dotenv";
import os from "os";

dotenv.config();

export const getSicoobAccessToken = async () => {
  try {
    const ip = Object.values(os.networkInterfaces())
      .flat()
      .find((iface) => iface.family === "IPv4" && !iface.internal)?.address;
    const hostname = os.hostname();

    console.log("🌐 Enviando requisição ao Sicoob (via cURL forçado Postman)...");
    console.log("🔑 Client ID:", process.env.SICOOB_CLIENT_ID);
    console.log("💻 IP detectado:", ip, "| Hostname:", hostname);

    // comando idêntico ao Postman, incluindo user-agent
    const curlCommand = `
      curl --silent --location '${process.env.SICOOB_AUTH_URL}' \
      -H 'Content-Type: application/x-www-form-urlencoded' \
      -H 'User-Agent: PostmanRuntime/7.39.0' \
      -H 'Accept: */*' \
      -H 'Accept-Encoding: gzip, deflate, br' \
      -H 'Connection: keep-alive' \
      -H 'Cookie: TS012629b2=017a3a183b55fd13b2d842a477f9dc425d7d004cae0ce547ea640e833a2c93f4df405fe18796ca2200374139c07ac1e99ec85ad397a2b7573e294c96c53a71f251678e2a6c; b0efc75d7d39f07bd614e7d7ab16c9b7=fbe68d12c01d52d8bf8d498cb3065be0' \
      --data-urlencode 'grant_type=client_credentials' \
      --data-urlencode 'client_id=${process.env.SICOOB_CLIENT_ID}' \
      --data-urlencode 'scope=pix.read cobv.read lotecobv.write payloadlocation.read webhook.write cob.read'
    `;

    const output = execSync(curlCommand).toString().trim();
    const json = JSON.parse(output);

    if (!json.access_token) {
      console.error("❌ Erro ao obter token Sicoob:", json);
      throw new Error("Falha na autenticação com o Sicoob");
    }

    console.log("✅ Token obtido com sucesso!");
    return json.access_token;
  } catch (error) {
    console.error("❌ Erro ao obter token Sicoob:", error.message);
    throw new Error("Falha na autenticação com o Sicoob");
  }
};
