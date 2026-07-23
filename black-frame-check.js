// 블랙화면 감지 스크립트 (broadcast-alert.yml 워크플로에서 5분마다 같이 실행됨)
// -----------------------------------------------------------------
// 연결(healthy)은 정상인데 화면이 새까맣게 나가는 경우 - vMix에서 소스만 끊긴 경우 등.
// isHealthy만으로는 못 잡아서, 실제 영상 프레임을 ffmpeg로 몇 초 분석해서 판단함.

const fs = require('fs');
const { execFile } = require('child_process');
const webpush = require('web-push');

const API_URL = 'https://mlc-api.cjoshopping.com/external/public/api/streamhistory/dashboard/v2/live';
const STUDIO_LIST = ["M1","M2","M3","M5","M6","A","B","C","E","V1","V2","V3","ETC1","ETC2"];
const SUBS_FILE = 'subscriptions.json';
const STATE_FILE = 'blackframe-state.json';
const HISTORY_FILE = 'alarm-history.json'; // 팀 전체가 같이 볼 수 있는 서버발 알람 발송 기록
const HISTORY_RETAIN_DAYS = 7;
const CHECK_SECONDS = 3; // 스트림에서 이만큼만 받아서 분석(전체 다운로드 안 함)

function loadJSON(path, fallback) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); }
  catch (e) { return fallback; }
}

function studioFromChnCd(chncd) {
  if (!chncd) return null;
  const m = /^prd_elemental_studio_(.+)_(MASTER|SLAVE)$/.exec(chncd);
  return m ? m[1] : null;
}

// 대시보드 items에서 "지금 공식적으로 방송중(onair)"인 스튜디오와 그 URL을 뽑음
// (여러 항목이 겹치면 onair인 쪽을 우선)
function pickOnairUrls(items) {
  const byStudio = {};
  items.forEach((it) => {
    const name = studioFromChnCd(it.mainChnCd) || studioFromChnCd(it.subChnCd);
    if (!name || !STUDIO_LIST.includes(name)) return;
    const liveByType = {};
    (it.liveStateList || []).forEach((ls) => { liveByType[ls.streamType] = ls; });
    const main = liveByType.MAIN;
    const sub = liveByType.SUB;
    const mainOnair = !!(main && main.isRecording && main.isHealthy);
    const slaveOnair = !!(sub && sub.isRecording && sub.isHealthy);
    if (!mainOnair && !slaveOnair) return;
    const url = mainOnair ? it.mainRecvUrl : it.subRecvUrl;
    if (!url) return;
    if (!byStudio[name]) byStudio[name] = url; // 이미 잡혀있으면 그대로 둠(중복 항목 방지)
  });
  return byStudio;
}

// ffmpeg의 blackdetect 필터 출력에 "black_start"가 있으면 까만 프레임이 감지된 것
function isBlackOutput(output) {
  return /black_start/i.test(output);
}

function runBlackDetect(url) {
  return new Promise((resolve) => {
    execFile(
      'ffmpeg',
      ['-i', url, '-t', String(CHECK_SECONDS), '-vf', 'blackdetect=d=1:pic_th=0.98', '-an', '-f', 'null', '-'],
      { timeout: 20000 },
      (err, stdout, stderr) => {
        // ffmpeg는 정상적일 때도 exit code가 0이 아닐 수 있음(스트림을 -t로 잘라서 끊어서) - 출력 내용으로만 판단
        resolve(isBlackOutput(String(stdout) + String(stderr)));
      }
    );
  });
}

// 순수 로직: 현재 감지결과와 이전 상태를 비교해 알림 목록/새 상태를 만듦
function decideAlerts(prevState, blackResults) {
  const newState = {};
  const alerts = [];
  Object.keys(blackResults).forEach((studio) => {
    const isBlack = blackResults[studio];
    newState[studio] = isBlack;
    if (isBlack && !prevState[studio]) {
      alerts.push(studio); // 정상 -> 블랙으로 막 전환된 순간에만 알림
    }
  });
  return { alerts, newState };
}

async function main() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    console.error('VAPID 키가 설정되어 있지 않습니다');
    process.exit(1);
  }

  const res = await fetch(API_URL, { headers: { Accept: 'application/json' } });
  if (!res.ok) { console.error('대시보드 조회 실패:', res.status); process.exit(1); }
  const data = await res.json();
  const items = Array.isArray(data.result) ? data.result : [];
  const onairUrls = pickOnairUrls(items);

  if (Object.keys(onairUrls).length === 0) {
    console.log('지금 공식 방송중인 스튜디오가 없습니다 - 종료');
    return;
  }

  const blackResults = {};
  for (const [studio, url] of Object.entries(onairUrls)) {
    blackResults[studio] = await runBlackDetect(url);
    console.log(`${studio}: ${blackResults[studio] ? '블랙 감지됨' : '정상'}`);
  }

  const prevState = loadJSON(STATE_FILE, {});
  const { alerts, newState } = decideAlerts(prevState, blackResults);

  // 방송이 끝난 스튜디오는 상태에서 지움(다음에 다시 방송 시작하면 새로 판단하도록)
  const finalState = {};
  Object.keys(onairUrls).forEach((studio) => { finalState[studio] = newState[studio]; });
  fs.writeFileSync(STATE_FILE, JSON.stringify(finalState, null, 2));

  if (alerts.length === 0) {
    console.log('새로 감지된 블랙화면 없음');
    return;
  }

  webpush.setVapidDetails('mailto:admin@example.com', publicKey, privateKey);
  const subscriptions = loadJSON(SUBS_FILE, []);
  const targets = subscriptions.filter((s) => !s.settings || s.settings.blackFrameEnabled !== false);

  for (const studio of alerts) {
    const payload = JSON.stringify({
      title: `MLC 블랙화면 감지 - ${studio}`,
      body: `${studio} 스튜디오 - 연결은 정상이지만 화면이 블랙화면으로 송출됩니다.`,
      tag: `mlc-black-${studio}`,
    });
    for (const sub of targets) {
      try { await webpush.sendNotification(sub, payload); }
      catch (err) { console.error(`발송 실패(${studio}):`, err.statusCode || err.message); }
    }
  }
  console.log(`블랙화면 알림 발송: ${alerts.join(', ')} (구독자 ${targets.length}명)`);

  const hist = loadJSON(HISTORY_FILE, []);
  alerts.forEach((studio) => {
    hist.push({
      time: new Date().toISOString(),
      type: 'blackframe',
      studio,
      message: `${studio} 스튜디오 - 연결은 정상이지만 화면이 블랙화면으로 송출됩니다.`,
    });
  });
  const cutoff = Date.now() - HISTORY_RETAIN_DAYS * 24 * 60 * 60 * 1000;
  const pruned = hist.filter((e) => new Date(e.time).getTime() >= cutoff);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(pruned, null, 2));
}

module.exports = { pickOnairUrls, isBlackOutput, decideAlerts };

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
