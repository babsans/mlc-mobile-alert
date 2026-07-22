// MLC 방송예고 알림 발송 스크립트 (GitHub Actions에서 5분마다 실행)
// -----------------------------------------------------------------
// 편성시간(scheStrDtm) 기준 30/15/10/5분 전 문턱을 넘는 순간 구독자들에게 Web Push 발송.
// 크론 실행 시각이 정확히 맞지 않을 수 있어서(GitHub Actions 특성), 문턱을 살짝 지나쳐
// 감지되더라도(CATCH_WINDOW 분 이내) 놓치지 않고 보내되, 같은 방송의 같은 문턱은
// alerted-log.json에 기록해서 중복 발송하지 않음.

const fs = require('fs');
const webpush = require('web-push');

const API_URL = 'https://mlc-api.cjoshopping.com/external/public/api/streamhistory/dashboard/v2/live';
const STUDIO_LIST = ["M1","M2","M3","M5","M6","A","B","C","E","ETC1","ETC2"];
const THRESHOLDS = [30, 15, 10, 5]; // 방송 시작 몇 분 전에 알릴지
const CATCH_WINDOW = 10; // 문턱보다 최대 이만큼(분) 늦게 감지돼도 놓치지 않고 보냄

const SUBS_FILE = 'subscriptions.json';
const LOG_FILE = 'alerted-log.json';

function loadJSON(path, fallback) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); }
  catch (e) { return fallback; }
}

// mlc_mobile_viewer.html과 동일한 로직 - mappNm은 SCHEDULED 상태일 때 신뢰 불가하므로
// mainChnCd/subChnCd("prd_elemental_studio_M1_MASTER")에서 스튜디오 코드를 직접 추출
function studioFromChnCd(chncd) {
  if (!chncd) return null;
  const m = /^prd_elemental_studio_(.+)_(MASTER|SLAVE)$/.exec(chncd);
  return m ? m[1] : null;
}

async function main() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    console.error('VAPID 키가 설정되어 있지 않습니다 (저장소 Secrets 확인 필요)');
    process.exit(1);
  }
  webpush.setVapidDetails('mailto:admin@example.com', publicKey, privateKey);

  const subscriptions = loadJSON(SUBS_FILE, []);
  if (subscriptions.length === 0) {
    console.log('등록된 구독자가 없습니다 - 종료');
    return;
  }

  const alertedLog = loadJSON(LOG_FILE, {});
  const now = Date.now();

  const res = await fetch(API_URL, { headers: { Accept: 'application/json' } });
  if (!res.ok) { console.error('대시보드 조회 실패:', res.status); process.exit(1); }
  const data = await res.json();
  const items = Array.isArray(data.result) ? data.result : [];

  // 스튜디오별로 "가장 가까운 미래의 예정 방송" 하나만 골라냄
  const nextByStudio = {};
  items.forEach(it => {
    if (!it.scheStrDtm) return;
    const name = studioFromChnCd(it.mainChnCd) || studioFromChnCd(it.subChnCd);
    if (!name || !STUDIO_LIST.includes(name)) return;
    const startTime = new Date(it.scheStrDtm.replace(' ', 'T')).getTime();
    if (isNaN(startTime)) return;
    if (startTime - now < 0) return; // 이미 시작했거나 지난 예정은 방송예고 대상 아님
    const existing = nextByStudio[name];
    if (!existing || startTime < existing.startTime) {
      nextByStudio[name] = { startTime, title: it.bdTit || '', scheStrDtm: it.scheStrDtm };
    }
  });

  const toSend = [];
  Object.entries(nextByStudio).forEach(([studio, info]) => {
    const diffMin = (info.startTime - now) / 60000;
    THRESHOLDS.forEach(th => {
      if (diffMin > th || diffMin < th - CATCH_WINDOW) return; // 이 문턱 구간이 아님
      const key = `${studio}_${info.scheStrDtm}_${th}`;
      if (alertedLog[key]) return; // 이미 이 방송의 이 문턱은 보냄
      toSend.push({ studio, threshold: th, key, title: info.title });
    });
  });

  console.log(`예정 방송 ${Object.keys(nextByStudio).length}건 확인, 보낼 알림 ${toSend.length}건`);

  for (const alert of toSend) {
    const payload = JSON.stringify({
      title: `MLC 방송예고 - ${alert.studio}`,
      body: `${alert.threshold}분 후 방송 시작 예정${alert.title ? ` (${alert.title})` : ''}`,
      tag: `mlc-schedule-${alert.studio}`,
    });
    for (const sub of subscriptions) {
      try {
        await webpush.sendNotification(sub, payload);
      } catch (err) {
        console.error(`발송 실패 (${alert.studio}, ${alert.threshold}분전):`, err.statusCode || err.message);
        // 410/404는 구독 만료(폰에서 알림 껐거나 재설치 등) - 지금은 로그만 남김
      }
    }
    alertedLog[alert.key] = new Date().toISOString();
    console.log(`발송 완료: ${alert.studio} ${alert.threshold}분 전 알림`);
  }

  // 로그 파일이 무한정 커지지 않게 3일 지난 기록은 정리
  const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;
  Object.keys(alertedLog).forEach(k => {
    if (now - new Date(alertedLog[k]).getTime() > THREE_DAYS) delete alertedLog[k];
  });

  fs.writeFileSync(LOG_FILE, JSON.stringify(alertedLog, null, 2));
}

main().catch(err => { console.error(err); process.exit(1); });
