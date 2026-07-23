// MLC 방송 알람 발송 스크립트 (GitHub Actions에서 1분마다 실행) - v4
// -----------------------------------------------------------------
// v3에서 변경:
//  - 재방송(rerun) 알람에도 방송예고와 동일한 3회 연속확인 게이트를 적용 - 재방송도
//    같은 엘리멘탈 자동화가 편성 전환을 처리하므로 동일한 시차성 오탐 가능성이 있어서
// v2에서 변경:
//  - 방송예고(pre) 알람: "30분 전인데 신호없음"을 딱 한 번 확인하고 바로 보내던 방식에서,
//    3번 연속(10초씩 총 약 20~30초) 확인돼야 보내는 방식으로 변경 - 엘리멘탈 자동 송출시작
//    타이밍과 우리 체크 타이밍이 겹쳐서 생기는 찰나의 시차성 오탐 방지 (신호끊김은 그대로 즉시 발송)
//  - 감시 구간도 "문턱-10분~문턱" 좁은 구간에서 "문턱~방송시작" 전체로 확장
//  - 구독자마다 다른 문턱(threshold)/개별방송 오버라이드/재방송 알람 on-off를 가짐
//    (subscriptions.json의 각 항목에 붙은 settings 필드를 그대로 씀)
//  - "시작 X분 전"이 됐다고 무조건 보내는 게 아니라, 그 시점에 신호(healthy)가
//    아직 안 들어와 있을 때만 보냄 - 신호 정상이면 조용히 넘어감
//  - 재방송(V스튜디오)은 반대로 "편성시간이 지났는데" 영상이 안 뜨면 보냄

const fs = require('fs');
const webpush = require('web-push');

const API_URL = 'https://mlc-api.cjoshopping.com/external/public/api/streamhistory/dashboard/v2/live';
const STUDIO_LIST = ["M1","M2","M3","M5","M6","A","B","C","E","V1","V2","V3","ETC1","ETC2"];
const RERUN_GRACE_MIN = 10;  // 재방송 편성시간이 지나고 이 안에는 "아직 안 뜬 것" 체크 대상으로 봄
const PRE_REQUIRED_CONFIRMS = 3; // 방송예고·재방송 알람: 이 횟수만큼 연속으로 계속 신호없음이어야 실제 발송
                                  // - 엘리멘탈 자동 송출시작(문턱과 같은 30분전 등)과 우리 체크 타이밍이
                                  //   겹쳐서 생기는 찰나의 시차성 오탐을 걸러내기 위함
const SUB_CHECK_INTERVAL_MS = 10000; // 트리거 1번(1분마다) 안에서 이 간격으로 여러 번 재확인
const SUB_CHECKS_PER_RUN = 4;        // 10초 x 4번 = 3번 확정(PRE_REQUIRED_CONFIRMS) + 여유 1번, 약 30초 소요

const SUBS_FILE = 'subscriptions.json';
const LOG_FILE = 'alerted-log.json';
const PENDING_FILE = 'pending-log.json';
const HISTORY_FILE = 'alarm-history.json'; // 팀 전체가 같이 볼 수 있는 서버발 알람 발송 기록 (기기 로컬 기록과 별개)
const HISTORY_RETAIN_DAYS = 7;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

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
      // 30분(문턱) 전부터 방송 시작 직전까지 계속(1분마다) 감시 대상 - 예전엔 "문턱-10분~문턱"
      // 사이의 좁은 구간만 봤는데, 그러면 그 구간을 놓치면 다시는 체크 안 되는 문제가 있었음
      if (diffMin > eff.threshold || diffMin < 0) return;
      if (healthy) return;
      const key = `${subId}_pre_${studio}_${info.scheStrDtm}_${eff.threshold}`;
      if (alertedLog[key]) return;
      toSend.push({ studio, type: 'pre', key, title: info.title, threshold: eff.threshold,
        message: `${studio} 방송 ${eff.threshold}분 전인데 신호가 없습니다.${info.title ? ` (${info.title})` : ''}` });
    }
  });

  return toSend;
}

// 한 번의 "API 조회 + 판단 + 발송" 과정. main()에서 10초 간격으로 여러 번 호출됨
// (같은 트리거 1회 실행 안에서 alertedLog/pendingLog/totalSent를 계속 이어받아 누적함)
async function runOnePass(subscriptions, alertedLog, pendingLog, totals, historyLog, historyDedup) {
  const res = await fetch(API_URL, { headers: { Accept: 'application/json' } });
  if (!res.ok) { console.error('대시보드 조회 실패:', res.status); return; }
  const data = await res.json();
  const items = Array.isArray(data.result) ? data.result : [];
  const analysis = analyzeDashboard(items);

  const seenThisPass = new Set(); // 이번 조회에서 조건이 참이었던 pre 알람 key들(연속 확인 끊김 감지용)

  for (const sub of subscriptions) {
    const settings = normalizeSettings(sub.settings);
    const subId = (sub.endpoint || '').slice(-24);
    const alerts = computeAlertsForSubscriber(settings, analysis, alertedLog, subId);

    for (const alert of alerts) {
      // 방송예고(pre)/재방송(rerun) 둘 다 엘리멘탈 자동화 타이밍과 겹쳐서 생기는
      // 시차성 오탐이 있을 수 있어 같은 연속확인 게이트를 적용함 (신호끊김/블랙화면은 해당 없음)
      if (alert.type === 'pre' || alert.type === 'rerun') {
        seenThisPass.add(alert.key);
        const confirmCount = (pendingLog[alert.key] || 0) + 1;
        if (confirmCount < PRE_REQUIRED_CONFIRMS) {
          pendingLog[alert.key] = confirmCount; // 아직 연속 확인 부족 - 이번엔 발송 보류
          console.log(`대기(${confirmCount}/${PRE_REQUIRED_CONFIRMS}): [${alert.type}] ${alert.studio} -> ${subId}`);
          continue;
        }
        delete pendingLog[alert.key]; // 확인 완료 - 발송 진행
      }

      const payload = JSON.stringify({
        title: `MLC 알람 - ${alert.studio}`,
        body: alert.message,
        tag: `mlc-${alert.type}-${alert.studio}`,
      });
      try {
        await webpush.sendNotification(sub, payload);
        totals.sent++;
        console.log(`발송: [${alert.type}] ${alert.studio} -> ${subId}`);
        // 팀 전체가 같이 보는 서버 기록 - 구독자마다 반복 발송돼도 같은 사건은 한 번만 남김
        const histKey = `${alert.type}|${alert.studio}|${alert.message}`;
        if (!historyDedup.has(histKey)) {
          historyDedup.add(histKey);
          historyLog.push({ time: new Date().toISOString(), type: alert.type, studio: alert.studio, message: alert.message });
        }
      } catch (err) {
        console.error(`발송 실패 (${alert.studio}, ${alert.type}):`, err.statusCode || err.message);
      }
      alertedLog[alert.key] = new Date().toISOString();
    }
  }

  // 이번 조회에서 조건이 더 이상 참이 아니게 된(신호가 정상으로 돌아온) pre 후보는
  // 연속확인이 끊긴 것이므로 제거 - 그래야 나중에 다시 조건이 성립할 때 처음부터(1/3) 새로 카운트함
  Object.keys(pendingLog).forEach(k => { if (!seenThisPass.has(k)) delete pendingLog[k]; });
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
  const pendingLog = loadJSON(PENDING_FILE, {}); // key -> 지금까지 연속으로 확인된 횟수
  const historyLog = loadJSON(HISTORY_FILE, []); // 팀 전체가 같이 보는 서버 발송 기록
  const historyDedup = new Set();
  const totals = { sent: 0 };

  // 트리거는 Cloudflare가 1분마다 보내지만, 그 1번의 실행 안에서 10초 간격으로 여러 번
  // 재확인함 - 그러면 "3번 연속 확인"이 서로 다른 실행(총 2분)에 안 걸치고 한 번의
  // 실행(총 약 30초) 안에서 끝나서, 실제 알람 발동까지 걸리는 시간이 훨씬 짧아짐.
  for (let i = 0; i < SUB_CHECKS_PER_RUN; i++) {
    await runOnePass(subscriptions, alertedLog, pendingLog, totals, historyLog, historyDedup);
    if (i < SUB_CHECKS_PER_RUN - 1) await sleep(SUB_CHECK_INTERVAL_MS);
  }

  console.log(`총 발송 ${totals.sent}건 (구독자 ${subscriptions.length}명 대상)`);

  const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  Object.keys(alertedLog).forEach(k => {
    if (now - new Date(alertedLog[k]).getTime() > THREE_DAYS) delete alertedLog[k];
  });
  fs.writeFileSync(LOG_FILE, JSON.stringify(alertedLog, null, 2));
  fs.writeFileSync(PENDING_FILE, JSON.stringify(pendingLog, null, 2));

  const historyCutoff = now - HISTORY_RETAIN_DAYS * 24 * 60 * 60 * 1000;
  const prunedHistory = historyLog.filter(e => new Date(e.time).getTime() >= historyCutoff);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(prunedHistory, null, 2));
}

module.exports = { analyzeDashboard, computeAlertsForSubscriber, effectiveLiveSetting, normalizeSettings };

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}
