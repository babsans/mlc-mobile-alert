// MLC 모바일뷰어 - Service Worker (2단계: 방송예고 Push 알림용)
// -----------------------------------------------------------------
// 내일 할 일: GitHub Pages에 이 파일들을 올리고 나서 VAPID 키를 생성해
// 아래 push 이벤트가 실제로 동작하는지 실기기(화면꺼짐 포함)로 확인해야 함.
// 지금은 코드만 준비된 상태 - 아직 배포/테스트 전.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// 서버(GitHub Actions)가 Web Push로 보낸 payload를 받아 알림으로 표시
self.addEventListener('push', (event) => {
  let data = { title: 'MLC 방송예고', body: '' };
  try { data = event.data ? event.data.json() : data; } catch (e) {}

  const options = {
    body: data.body || '',
    tag: data.tag || 'mlc-broadcast-alert',
    vibrate: [200, 100, 200],
    requireInteraction: false,
  };
  event.waitUntil(self.registration.showNotification(data.title || 'MLC 방송예고', options));
});

// 알림 탭하면 모바일뷰어 창으로 포커스 이동 (열려있으면 그 창, 없으면 새로 열기)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clientsArr) => {
      const existing = clientsArr.find((c) => c.url.includes(self.registration.scope));
      if (existing) return existing.focus();
      return self.clients.openWindow('./');
    })
  );
});
