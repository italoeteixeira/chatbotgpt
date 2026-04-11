import pkg from 'whatsapp-web.js';
import { config } from './config.js';

const { Client, LocalAuth } = pkg;

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: `${config.sessionName}-list`,
    dataPath: config.sessionDir
  }),
  puppeteer: {
    headless: config.puppeteerHeadless,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  }
});

client.on('qr', () => {
  console.log('QR gerado. Para ver no navegador, rode o bot principal com painel web.');
});

client.on('ready', async () => {
  const chats = await client.getChats();
  const groups = chats
    .filter((chat) => chat.isGroup)
    .map((group) => ({
      id: group.id._serialized,
      name: group.name
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

  if (!groups.length) {
    console.log('Nenhum grupo encontrado para esta sessao.');
  } else {
    console.log('Grupos encontrados:');
    for (const group of groups) {
      console.log(`- ${group.name} => ${group.id}`);
    }
  }

  await client.destroy();
  process.exit(0);
});

client.initialize().catch(async (error) => {
  console.error('Falha ao listar grupos:', error instanceof Error ? error.message : String(error));
  try {
    await client.destroy();
  } catch {}
  process.exit(1);
});
