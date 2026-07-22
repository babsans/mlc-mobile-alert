// MLC 방송 알람 발송 스크립트 (GitHub Actions에서 5분마다 실행) - v2
// -----------------------------------------------------------------
// v1(고정 30/15/10/5분 다단계 리마인더)에서 변경:
//  - 구독자마다 다른 문턱(threshold)/개별방송 오버라이드/재방송 알람 on-off를 가짐
//    (subscriptions.json의 각 항목에 붙은 settings 필드를 그대로 씀)
//  - "시작 X분 전"이 됐다고 무조건 보내는 게 아니라, 그 시점에 신호(healthy)가
//    아직 안 들어와 있을 때만 보냄 - 신호 정상이면 조용히 넘어감
//  - 재방송(V스튜디오)은 반대로 "편성시간이 지났는데" 영상이 안 뜨면 보냄

const fs = require('fs');
const webpush = require('web-push');

const API_URL = 'https://mlc-api.cjoshopping.com/external/public/api/streamhistory/dashboard/v2/live';
const STUDIO_LIST = ["M1","M2","M3","M5","M6","A","B","C","E","V1","V2","V3","ETC1","ETC2"];
const CATCH_WINDOW = 10;     // 문턱을 최대 이만큼(분) 늦게 감지해도 놓치지 않고 보냄(크론 지연 대비)
const RERUN_GRACE_MIN = 10;  // 재방송 편성시간이 지나고 이 안에는 "아직 안 뜬 것" 체크 대상으로 봄

const SUBS_FILE = 'subscriptions.json';
const LOG_FILE = 'alerted-log.json';

const DEFAULT_SETTINGS = { liveEnabled: true, liveThreshold: 30, rerunEnabled: true, overrides: {} };

function loadJSON(path, fallback) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); }
  catch (e) { return fallback; }
}

function studioFromChnCd(chncd) {
  if (!chncd) return null;
  const m = /^prd_elemental_studio_(.+)_(MASTER|SLAVE)$/.exec(chncd);
  return m ? m[1] : null;
}

function normalizeSettings(settings) {
  const s = settings || {};
  return {
    liveEnabled: s.liveEnabled !== undefined ? s.liveEnabled : DEFAULT_SETTINGS.liveEnabled,
    liveThreshold: s.liveThreshold || DEFAULT_SETTINGS.liveThreshold,
    rerunEnabled: s.rerunEnabled !== undefined ? s.rerunEnabled : DEFAULT_SETTINGS.rerunEnabled,
    overrides: s.overrides || {},
  };
}

function effectiveLiveSetting(settings, studio, scheStrDtm) {
  const ov = settings.overrides[`${studio}_${scheStrDtm}`];
  if (ov === 'off') return { enabled: false, threshold: null };
  if (ov) return { enabled: true, threshold: Number(ov) };
  return { enabled: settings.liveEnabled, threshold: settings.liveThreshold };
}

function analyzeDashboard(items) {
  const now = Date.now();
  const nextFuture = {};
  const justPassed = {};
  const healthyMap = {};

  items.forEach(it => {
    const name = studioFromChnCd(it.mainChnCd) || studioFromChnCd(it.subChnCd);
    if (!name || !STUDIO_LIST.includes(name)) return;

    const anyHealthy = (it.liveStateList || []).some(ls => ls.isHealthy);
    if (anyHealthy) healthyMap[name] = true;
    else if (!(name in healthyMap)) healthyMap[name] = false;

    if (!it.scheStrDtm) return;
    const startTime = new Date(it.scheStrDtm.replace(' ', 'T')).getTime();
    if (isNaN(startTime)) return;
    const diff = startTime - now;
    const entry = { startTime, scheStrDtm: it.scheStrDtm, title: it.bdTit || '' };

    if (diff >= 0) {
      if (!nextFuture[name] || startTime < nextFuture[name].startTime) nextFuture[name] = entry;
    } else {
      if (!justPassed[name] || startTime > justPassed[name].startTime) justPassed[name] = entry;
    }
  });

  return { nextFuture, justPassed, healthyMap, now };
}

function computeAlertsForSubscriber(settings, analysis, alertedLog, subId) {
  const { nextFuture, justPassed, healthyMap, now } = analysis;
  const toSend = [];

  STUDIO_LIST.forEach(studio => {
    const isRerun = studio.startsWith('V');
    const healthy = !!healthyMap[studio];

    if (isRerun) {
      if (!settings.rerunEnabled) return;
      const info = justPassed[studio];
      if (!info) return;
      const diffMin = (now - info.startTime) / 60000;
      if (diffMin < 0 || diffMin > RERUN_GRACE_MIN) return;
      if (healthy) return;
      const key = `${subId}_rerun_${studio}_${info.scheStrDtm}`;
      if (alertedLog[key]) return;
      toSend.push({ studio, type: 'rerun', key, title: info.title,
        message: `${studio} 재방송 시간인데 영상이 안 뜹니다.` });
    } else {
      const info = nextFuture[studio];
      if (!info) return;
      const eff = effectiveLiveSetting(settings, studio, info.scheStrDtm);
      if (!eff.enabled) return;
      const diffMin = (info.startTime - now) / 60000;
      if (diffMin > eff.threshold || diffMin < eff.threshold - CATCH_WINDOW) return;
      if (healthy) return;
      const key = `${subId}_pre_${studio}_${info.scheStrDtm}_${eff.threshold}`;
      if (alertedLog[key]) return;
      toSend.push({ studio, type: 'pre', key, title: info.title, threshold: eff.threshold,
        message: `${studio} 방송 ${eff.threshold}분 전인데 신호가 없습니다.${info.title ? ` (${info.title})` : ''}` });
    }
  });

  return toSend;
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

  const res = await fetch(API_URL, { headers: { Accept: 'application/json' } });
  if (!res.ok) { console.error('대시보드 조회 실패:', res.status); process.exit(1); }
  const data = await res.json();
  const items = Array.isArray(data.result) ? data.result : [];
  const analysis = analyzeDashboard(items);

  let totalSent = 0;
  for (const sub of subscriptions) {
    const settings = normalizeSettings(sub.settings);
    const subId = (sub.endpoint || '').slice(-24);
    const alerts = computeAlertsForSubscriber(settings, analysis, alertedLog, subId);

    for (const alert of alerts) {
      const payload = JSON.stringify({
        title: `MLC 알람 - ${alert.studio}`,
        body: alert.message,
        tag: `mlc-${alert.type}-${alert.studio}`,
      });
      try {
        await webpush.sendNotification(sub, payload);
        totalSent++;
        console.log(`발송: [${alert.type}] ${alert.studio} -> ${subId}`);
      } catch (err) {
        console.error(`발송 실패 (${alert.studio}, ${alert.type}):`, err.statusCode || err.message);
      }
      alertedLog[alert.key] = new Date().toISOString();
    }
  }

  console.log(`총 발송 ${totalSent}건 (구독자 ${subscriptions.length}명 대상)`);

  const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  Object.keys(alertedLog).forEach(k => {
    if (now - new Date(alertedLog[k]).getTime() > THREE_DAYS) delete alertedLog[k];
  });
  fs.writeFileSync(LOG_FILE, JSON.stringify(alertedLog, null, 2));
}

module.exports = { analyzeDashboard, computeAlertsForSubscriber, effectiveLiveSetting, normalizeSettings };

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}
