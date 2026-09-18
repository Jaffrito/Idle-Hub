// ---------------------------------------------------------------------------
// Atualiza automaticamente o Gist de aviso de versão (aquele que o app lê no
// checkForUpdatesOnStartup / UPDATE_GIST_URL do renderer.js).
//
// Uso:
//   GIST_TOKEN=seu_token_classico_com_escopo_gist node scripts/update-gist.js
//   GIST_TOKEN=... node scripts/update-gist.js "Texto da mensagem pra essa versão"
//
// O GIST_TOKEN precisa ser um token CLÁSSICO do GitHub com o escopo "gist"
// marcado — a API de Gists ainda não é coberta por tokens fine-grained
// (o mesmo GH_TOKEN usado pelo electron-builder não serve aqui).
// ---------------------------------------------------------------------------
const https = require('https');
const path = require('path');

const GIST_ID = 'f623667cd54a8e5473cf7bebfec0bcae'; // do seu UPDATE_GIST_URL
const RELEASES_URL = 'https://github.com/Jaffrito/Idle-Hub/releases';

const pkg = require(path.join(__dirname, '..', 'package.json'));
const version = pkg.version;
const message = process.argv[2] || 'Nova versão disponível! Confira as novidades na Release.';

const token = process.env.GIST_TOKEN;
if (!token) {
  console.error('Erro: defina a variável de ambiente GIST_TOKEN antes de rodar esse script.');
  console.error('Exemplo: GIST_TOKEN=seu_token node scripts/update-gist.js');
  process.exit(1);
}

function request(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: 'api.github.com',
        path: apiPath,
        method,
        headers: {
          'User-Agent': 'idle-hub-update-gist-script',
          Accept: 'application/vnd.github+json',
          Authorization: `token ${token}`,
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => { chunks += c; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(chunks)); } catch (err) { resolve(chunks); }
          } else {
            reject(new Error(`GitHub API respondeu ${res.statusCode}: ${chunks}`));
          }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  console.log(`Atualizando Gist ${GIST_ID} pra versão ${version}...`);

  // 1) Busca o gist pra descobrir o nome real do arquivo (evita ter que
  //    adivinhar/hardcodar — funciona não importa como você nomeou na hora
  //    de criar o gist).
  const gist = await request('GET', `/gists/${GIST_ID}`);
  const filenames = Object.keys(gist.files || {});
  if (!filenames.length) throw new Error('Gist sem nenhum arquivo — confirma o GIST_ID.');
  const filename = filenames.find((f) => f.toLowerCase().endsWith('.json')) || filenames[0];

  const content = JSON.stringify(
    { version, url: RELEASES_URL, message },
    null,
    2
  );

  // 2) Atualiza só esse arquivo, mantendo o resto do gist como está.
  await request('PATCH', `/gists/${GIST_ID}`, {
    files: { [filename]: { content } },
  });

  console.log(`Gist atualizado! (${filename} → version: "${version}")`);
}

main().catch((err) => {
  console.error('Falha ao atualizar o Gist:', err.message);
  process.exit(1);
});
