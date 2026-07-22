// 신호끊김 Push 발송 스크립트 (signal-loss-alert.yml 워크플로에서 실행됨)
// -----------------------------------------------------------------
// Cloudflare Worker가 감지한 "어느 스튜디오/어느 쪽이 끊겼는지"를 워크플로 입력값으로
// 받아서, subscriptions.json의 구독자 중 signalLossEnabled가 켜진 사람들에게만 발송함.

const fs = require('fs');
const webpush = require('web-push');

const SUBS_FILE = 'subscriptions.json';

function loadJSON(path, fallback) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); }
  catch (e) { return fallback; }
}

async function main() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const studio = process.env.STUDIO;
  const side = process.env.SIDE;

  if (!publicKey || !privateKey) {
    console.error('VAPID 키가 설정되어 있지 않습니다');
    process.exit(1);
  }
  if (!studio || !side) {
    console.error('studio/side 입력값이 없습니다');
    process.exit(1);
  }
  webpush.setVapidDetails('mailto:admin@example.com', publicKey, privateKey);

  const subscriptions = loadJSON(SUBS_FILE, []);
  const targets = subscriptions.filter(
    (s) => !s.settings || s.settings.signalLossEnabled !== false
  );

  if (targets.length === 0) {
    console.log('신호끊김 알림을 받도록 설정한 구독자가 없습니다 - 종료');
    return;
  }

  const payload = JSON.stringify({
    title: `MLC 신호끊김 - ${studio}`,
    body: `${studio} 스튜디오 ${side} 신호가 끊겼습니다.`,
    tag: `mlc-signal-loss-${studio}-${side}`,
  });

  let sent = 0;
  for (const sub of targets) {
    try {
      await webpush.sendNotification(sub, payload);
      sent++;
    } catch (err) {
      console.error(`발송 실패 (${sub.endpoint.slice(-24)}):`, err.statusCode || err.message);
    }
  }
  console.log(`발송 완료: ${sent}/${targets.length}명`);
}

main().catch((err) => { console.error(err); process.exit(1); });
