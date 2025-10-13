import { execSync } from "child_process";
import net from "net";

export const ensureRedisRunning = async () => {
  // 🚀 Ignora completamente o start local se for ambiente de produção
  if (process.env.NODE_ENV === "production") {
    console.log("🟢 Ambiente de produção detectado — ignorando start local do Redis");
    console.log("🔗 Use REDIS_URL para conectar a um Redis externo (Render Add-on ou Upstash)");
    return true;
  }

  return new Promise((resolve, reject) => {
    const checkRedis = () => {
      const client = net.createConnection({ port: 6379, host: "127.0.0.1" });

      client.on("connect", () => {
        console.log("✅ Redis já está rodando em 127.0.0.1:6379");
        client.end();
        resolve(true);
      });

      client.on("error", () => {
        console.log("⚙️ Redis não está rodando — iniciando automaticamente...");
        try {
          execSync("redis-server --daemonize yes");
          console.log("🚀 Redis iniciado em background, aguardando inicialização...");
          setTimeout(() => {
            console.log("✅ Redis pronto para uso!");
            resolve(true);
          }, 2000);
        } catch (err) {
          console.error("❌ Falha ao iniciar o Redis:", err.message);
          reject(err);
        }
      });
    };

    checkRedis();
  });
};
