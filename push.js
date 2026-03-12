const webpush = require('web-push');

function configurarWebPush() {
  webpush.setVapidDetails(
    'mailto:sentinela@app.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

async function enviarNotificacao(subscription, titulo, corpo, dados = {}) {
  const payload = JSON.stringify({
    title: titulo,
    body: corpo,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: dados.tag || 'sentinela',
    requireInteraction: dados.requireInteraction || false,
    data: dados
  });

  try {
    await webpush.sendNotification(subscription, payload);
    return true;
  } catch (err) {
    // Subscription expirada ou inválida
    if (err.statusCode === 410 || err.statusCode === 404) {
      return 'expirada';
    }
    console.error('Push erro:', err.message);
    return false;
  }
}

module.exports = { configurarWebPush, enviarNotificacao };
