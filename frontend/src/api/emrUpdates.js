/**
 * EMR 업데이트 WebSocket 클라이언트.
 *
 * 백엔드: api/app/routers/emr_updates.py · /ws/emr-updates?mrn=...
 * dev: vite proxy 가 /ws → ws://localhost:8000 으로 전달
 * production: CloudFront 의 별도 behavior (또는 직접 도메인) 으로 라우팅
 *
 * 메시지 스키마:
 *   { type: 'hello',      channel, mode, intervalSec }
 *   { type: 'emr-update', mrn, pendingDelta, delta[], since, now }
 *
 * 자동 재연결 (지수 백오프) + 25s heartbeat (서버가 ping 받으면 pong).
 */

const HEARTBEAT_MS = 25_000;
const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * @param {object} opts
 * @param {string} [opts.path='/ws/emr-updates']  · WebSocket 경로
 * @param {string} [opts.mrn]                     · 환자별 채널 (생략 시 글로벌 *)
 * @param {(msg: object) => void} [opts.onMessage]
 * @param {(msg: object) => void} [opts.onHello]
 * @param {(state: 'connecting'|'open'|'closed'|'error') => void} [opts.onState]
 * @returns {{ close: () => void }}
 */
export function connectEmrUpdates({
  path = '/ws/emr-updates',
  mrn,
  onMessage,
  onHello,
  onState,
} = {}) {
  let ws = null;
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let reconnectDelay = RECONNECT_INITIAL_MS;
  let stopped = false;

  function url() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const qs = mrn ? `?mrn=${encodeURIComponent(mrn)}` : '';
    return `${proto}//${window.location.host}${path}${qs}`;
  }

  function clearHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function clearReconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect() {
    if (stopped) return;
    clearReconnect();
    onState && onState('closed');
    reconnectTimer = setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
      open();
    }, reconnectDelay);
  }

  function open() {
    if (stopped) return;
    onState && onState('connecting');
    try {
      ws = new WebSocket(url());
    } catch (e) {
      console.warn('[emrUpdates] ws ctor failed', e);
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      reconnectDelay = RECONNECT_INITIAL_MS;
      onState && onState('open');
      clearHeartbeat();
      heartbeatTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          try { ws.send('ping'); } catch (_) {}
        }
      }, HEARTBEAT_MS);
    };

    ws.onmessage = (ev) => {
      const data = ev.data;
      if (data === 'pong') return;
      let msg;
      try {
        msg = JSON.parse(data);
      } catch (_) {
        return;
      }
      if (msg.type === 'hello') {
        onHello && onHello(msg);
        return;
      }
      onMessage && onMessage(msg);
    };

    ws.onclose = () => {
      clearHeartbeat();
      scheduleReconnect();
    };

    ws.onerror = () => {
      onState && onState('error');
      // close 가 자동 발생 → onclose 에서 reconnect.
    };
  }

  open();

  return {
    close() {
      stopped = true;
      clearHeartbeat();
      clearReconnect();
      if (ws) {
        try { ws.close(); } catch (_) {}
        ws = null;
      }
      onState && onState('closed');
    },
  };
}
