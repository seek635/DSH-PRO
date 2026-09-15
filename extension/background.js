'use strict';
// DSH PRO - background.js (MV3 Service Worker)
// 职责：
//  1. 代理 content script -> 桥接服务的所有 HTTP 请求（统一附加 Bearer token，规避页面 CORS）
//  2. handoff runId 轮询兜底：chrome.alarms 定期唤醒（content 页面在前台时自己也会更快轮询）
//  3. runId 存 chrome.storage.session，Service Worker 休眠后恢复仍可续查

const DEFAULT_BASE = 'http://127.0.0.1:8765';

async function getCfg() {
  const d = await chrome.storage.local.get(['token', 'baseUrl']);
  return { token: d.token || '', baseUrl: d.baseUrl || DEFAULT_BASE };
}

async function bridgeFetch({ method = 'GET', path = '/', body = null }) {
  const { token, baseUrl } = await getCfg();
  try {
    const res = await fetch(baseUrl + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try {
      json = await res.json();
    } catch {}
    return { ok: res.ok, status: res.status, json };
  } catch (e) {
    return { ok: false, status: 0, error: String((e && e.message) || e) };
  }
}

// ---- handoff 轮询兜底 ----
async function trackRun(runId) {
  const d = await chrome.storage.session.get({ runs: [] });
  const runs = d.runs.filter((r) => r !== runId);
  runs.push(runId);
  await chrome.storage.session.set({ runs });
  await chrome.alarms.create('dshpro-poll', { periodInMinutes: 0.5 });
}

async function untrackRun(runId) {
  const d = await chrome.storage.session.get({ runs: [] });
  await chrome.storage.session.set({ runs: d.runs.filter((r) => r !== runId) });
  const left = (await chrome.storage.session.get({ runs: [] })).runs;
  if (left.length === 0) await chrome.alarms.clear('dshpro-poll');
}

async function pollTrackedRuns() {
  const d = await chrome.storage.session.get({ runs: [] });
  const finished = [];
  for (const runId of d.runs) {
    const r = await bridgeFetch({ method: 'GET', path: '/handoff/' + runId });
    const status = r.json && r.json.run && r.json.run.status;
    if (status && status !== 'running') {
      finished.push({ runId, status });
      await untrackRun(runId);
      // 缓存最终状态，扩展醒来后可读取
      await chrome.storage.session.set({ ['last:' + runId]: r.json.run });
    }
  }
  return finished;
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'dshpro-poll') pollTrackedRuns();
});

// ---- 消息路由 ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case 'bridge':
        sendResponse(await bridgeFetch(msg));
        break;
      case 'trackHandoff':
        await trackRun(msg.runId);
        sendResponse({ ok: true });
        break;
      case 'handoffStatus': {
        const r = await bridgeFetch({ method: 'GET', path: '/handoff/' + msg.runId });
        const status = r.json && r.json.run && r.json.run.status;
        if (status && status !== 'running') await untrackRun(msg.runId);
        sendResponse(r);
        break;
      }
      default:
        sendResponse({ ok: false, error: 'unknown message type' });
    }
  })();
  return true; // 异步 sendResponse
});
