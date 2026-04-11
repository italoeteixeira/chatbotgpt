import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;
import { config } from '../src/config.js';

const GROUP_ID = '120363425653503107@g.us';
const IMAGE_PATH = '/opt/chatbot/data/imagens/img-1775497040517-9cf4a3b8.jpg';

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: config.sessionName,
    dataPath: config.sessionDir
  }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

client.on('ready', async () => {
  console.log('Cliente pronto. Enviando imagem...');
  try {
    const media = MessageMedia.fromFilePath(IMAGE_PATH);
    await client.sendMessage(GROUP_ID, media, {
      caption: '🚗 Fusca clássico gerado por IA — teste de geração de imagem validado com sucesso!'
    });
    console.log('ENVIADO COM SUCESSO!');
  } catch (err) {
    console.error('ERRO AO ENVIAR:', err.message);
  } finally {
    await client.destroy();
    process.exit(0);
  }
});

client.on('auth_failure', (msg) => {
  console.error('Auth failure:', msg);
  process.exit(1);
});

console.log('Inicializando cliente WhatsApp...');
client.initialize();
