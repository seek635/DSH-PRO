'use strict';
// DSH PRO - content.js（隔离世界）
// 职责：浮动面板 UI、协议握手、MutationObserver 监听 DeepSeek 回复、
//       提取 ⟦DSH⟧{json}⟦/DSH⟧ 工具调用 -> 桥接执行 -> 结果回填自动发送 -> 循环。
// 状态机：off -> handshake_wait -> idle --(发任务)--> wait -> executing -> sending -> wait -> ... -> idle
// 所有自动发送均经 2 秒预览（可取消），并有 1.5s 节流与单日发送上限。

(() => {
  // ---------------------------------------------------------------------------
  // 状态
  // ---------------------------------------------------------------------------
  const state = {
    token: '',
    baseUrl: 'http://127.0.0.1:8765',
    connected: false,
    health: null,
    tools: null,
    enabled: false, // 已完成协议握手
    phase: 'off',   // off | handshake_wait | idle | wait | executing | sending
    loopLimit: 15,
    loopsLeft: 15,
    dailyLimit: 200,
    workspace: '',
    lastProcessedKey: '',
    lastSentAssistantKey: '',
   fixups: 0,
    lastSendAt: 0,
    lastMutationAt: 0,
    customSelectors: null,
    stopping: false,
    handshakeAt: 0,       // handshake_wait 进入时间（用于超时提示）
    handshakeHinted: false,
    activeRunId: null,    // 正在轮询的 handoff runId（停止按钮据此真正取消）
  };

  const MARK_OPEN = '\u27E6DSH\u27E7';        // ⟦DSH⟧
  const MARK_CLOSE = '\u27E6/DSH\u27E7';      // ⟦/DSH⟧
  const DONE_RE = /(?:^|\n)\s*DSH:DONE[:：]\s*([\s\S]*)$/;
  const MAX_CALLS_PER_MSG = 3;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function log(msg) {
    const box = document.getElementById('dshpro-log');
    if (!box) return;
    const t = new Date().toLocaleTimeString();
    box.textContent = (`[${t}] ${msg}\n` + box.textContent).split('\n').slice(0, 60).join('\n');
  }

  function setPhase(p) {
    state.phase = p;
    const el = document.getElementById('dshpro-phase');
    if (el) {
      el.textContent = {
        off: '未启用',
        handshake_wait: '等待握手确认…',
        idle: '就绪',
        wait: '等待回复…',
        executing: '执行工具中…',
        sending: '发送结果…',
      }[p] || p;
    }
    updateDot();
  }

  function updateDot() {
    const dot = document.getElementById('dshpro-dot');
    if (!dot) return;
    dot.className = 'dshpro-dot' + (!state.connected ? ' err' : state.phase === 'executing' || state.phase === 'wait' ? ' busy' : ' ok');
  }

  // ---------------------------------------------------------------------------
  // 桥接（经 background 代理，规避页面 CORS）
  // ---------------------------------------------------------------------------
  function bridge(method, path, body) {
    return chrome.runtime.sendMessage({ type: 'bridge', method, path, body });
  }

  // ---------------------------------------------------------------------------
  // 选择器（内置候选 + 用户自定义覆盖）
  // ---------------------------------------------------------------------------
  function selList(kind) {
    const custom = state.customSelectors && state.customSelectors[kind];
    const builtin = DSHPRO_SELECTORS[kind] || [];
    return custom ? (Array.isArray(custom) ? custom.concat(builtin) : [custom].concat(builtin)) : builtin;
  }

  function lastVisible(list) {
    for (const s of list) {
      try {
        const all = document.querySelectorAll(s);
        for (let i = all.length - 1; i >= 0; i--) {
          const el = all[i];
          const r = el.getBoundingClientRect();
          if (r.width > 0 || r.height > 0) return el;
        }
      } catch (e) { /* 非法选择器跳过 */ }
    }
    return null;
  }

  function findLastAssistant() {
    return lastVisible(selList('assistantMarkdown'));
  }

  function findInput() {
    return lastVisible(selList('input'));
  }

  function findSendButton() {
    return lastVisible(selList('sendButton'));
  }

  function stopButtonVisible() {
    return Boolean(lastVisible(selList('stopButton')));
  }

  // ---------------------------------------------------------------------------
  // 输入与发送
  // ---------------------------------------------------------------------------
  function setNativeValue(el, text) {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      el.focus();
      let ok = false;
      try {
        ok = document.execCommand('insertText', false, text);
      } catch (e) { ok = false; }
      if (!ok) {
        el.textContent = text;
        el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      }
    }
  }

  function bumpDaily() {
    const today = new Date().toISOString().slice(0, 10);
    chrome.storage.local.get({ daily: { date: '', count: 0 } }, (d) => {
      const daily = d.daily.date === today ? d.daily : { date: today, count: 0 };
      daily.count++;
      chrome.storage.local.set({ daily });
    });
  }

  async function dailyExceeded() {
    const d = await chrome.storage.local.get({ daily: { date: '', count: 0 } });
    const today = new Date().toISOString().slice(0, 10);
    const count = d.daily.date === today ? d.daily.count : 0;
    return { exceeded: count >= state.dailyLimit, count };
  }

  // 预览 2 秒（可取消）；返回 true 表示继续发送
  function previewSend(text) {
    return new Promise((resolve) => {
      const box = document.getElementById('dshpro-preview');
      if (!box) return resolve(true);
      box.style.display = 'block';
      let left = 2;
      const render = () => {
        box.textContent = `即将发送（${left}s 后自动，点此取消）：\n` + text.slice(0, 500) + (text.length > 500 ? '\n…(已截断)' : '');
      };
      render();
      const timer = setInterval(() => {
        left--;
        if (left <= 0) {
          cleanup();
          resolve(true);
        } else render();
      }, 1000);
      const cleanup = () => {
        clearInterval(timer);
        box.style.display = 'none';
        box.onclick = null;
      };
      box.onclick = () => {
        cleanup();
        log('已取消本次自动发送');
        resolve(false);
      };
    });
  }

  async function sendText(text, { usePreview = true } = {}) {
    const { exceeded, count } = await dailyExceeded();
    if (exceeded) {
      log(`单日自动发送已达上限（${count}/${state.dailyLimit}），暂停。可在设置关闭后重置。`);
      setPhase(state.enabled ? 'idle' : 'off');
      return false;
    }
    if (usePreview) {
      const go = await previewSend(text);
      if (!go) return false;
    }
    // 节流：距上次发送 >= 1.5s
    const wait = 1500 - (Date.now() - state.lastSendAt);
    if (wait > 0) await sleep(wait);

    const input = findInput();
    if (!input) {
      log('找不到输入框（页面改版？请在设置里填自定义选择器）');
      return false;
    }
    state.lastSentAssistantKey = keyOf(findLastAssistant());
    setNativeValue(input, text);
    await sleep(150);
    const btn = findSendButton();
    if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
      btn.click();
    } else {
      input.focus();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    }
    state.lastSendAt = Date.now();
    bumpDaily();
    await sleep(600);
    return true;
  }

  // ---------------------------------------------------------------------------
  // 提取工具调用 / 完成标记
  // ---------------------------------------------------------------------------
  function keyOf(el) {
    if (!el) return '';
    // textContent 不受 CSS 折叠影响（display:none 的文本仍包含在内），比 innerText 稳定
    const t = el.textContent || el.innerText || '';
    return `${t.length}:${t.slice(-64)}`;
  }

  function extractCalls(text) {
    const calls = [];
    const re = new RegExp(MARK_OPEN + '([\\s\\S]*?)' + MARK_CLOSE, 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
      try {
        const obj = JSON.parse(m[1].trim());
        if (obj && typeof obj.tool === 'string') calls.push(obj);
      } catch (e) {
        calls.push({ tool: '__invalid__', args: {}, _raw: m[1].slice(0, 200) });
      }
      if (calls.length >= MAX_CALLS_PER_MSG) break;
    }
    return calls;
  }

  // ---------------------------------------------------------------------------
  // 工具执行
  // ---------------------------------------------------------------------------
  async function callBridgeTool(tool, args) {
    const t0 = Date.now();
    const r = await bridge('POST', '/tool', { tool, args, workspace: state.workspace || undefined });
    const durationMs = Date.now() - t0;
    if (!r || r.status === 0) {
      return { tool, ok: false, durationMs, error: { code: 'E_BRIDGE_UNREACHABLE', message: '桥接服务不可达（请确认 start-dsh-pro.cmd 已运行）' } };
    }
    const j = r.json || {};
    if (j.ok) return { tool, ok: true, durationMs, data: j.data };
    const err = j.error || { code: 'E_INTERNAL', message: '未知错误' };
    return { tool, ok: false, durationMs, error: err, _confirmExtra: (err.extra && err.extra.confirmToken) || null };
  }

  async function pollHandoff(runId, timeoutMs) {
    state.activeRunId = runId;
    const deadline = Date.now() + (timeoutMs || 300000) + 5000;
    let lastProgressLog = 0;
    let result = null;
    try {
      while (Date.now() < deadline) {
        if (state.stopping) { result = { status: 'cancelled', note: '用户停止' }; break; }
        await sleep(5000);
        const r = await chrome.runtime.sendMessage({ type: 'handoffStatus', runId });
        const run = r && r.json && r.json.run;
        if (run && run.status !== 'running') { result = run; break; }
        // 每 ~20s 向面板报一次进度（耗时 + dsh 实时输出尾部）；不进对话
        if (run && Date.now() - lastProgressLog > 20000) {
          lastProgressLog = Date.now();
          const tail = ((run.liveTail || '').split('\n').filter((s) => s.trim()).pop() || '').trim();
          const el = Math.floor((run.elapsedMs || 0) / 1000);
          log(`handoff ${runId} 执行中 ${Math.floor(el / 60)}:${String(el % 60).padStart(2, '0')}` +
            (tail ? ` · ${tail.slice(0, 100)}` : '（本地 agent 工作中，无中间消息打扰对话）'));
        }
      }
      return result || { status: 'timeout', note: '扩展轮询超时' };
    } finally {
      state.activeRunId = null;
      state.stopping = false; // 停止是一次性信号，本轮轮询结束即消费
    }
  }

  async function executeCalls(calls) {
    setPhase('executing');
    const results = [];
    for (let i = 0; i < calls.length; i++) {
      if (state.stopping) break;
      const c = calls[i];
      if (c.tool === '__invalid__') {
        results.push({ seq: i, tool: 'invalid', ok: false, error: { code: 'E_ARGS_INVALID', message: 'dsh 标记内不是合法 JSON 或缺 tool 字段：' + (c._raw || '') } });
        continue;
      }
      const r = await callBridgeTool(c.tool, c.args || {});
      // handoff：轮询到终态再回填
      if (r.ok && c.tool === 'dsh_handoff' && r.data && r.data.runId) {
        log(`handoff ${r.data.runId} 执行中…`);
        const run = await pollHandoff(r.data.runId, r.data.timeoutMs);
        let stdout = run.stdout || '';
        if (stdout.length > 16000) {
          stdout = stdout.slice(0, 16000) + `\n…(截断，完整输出: ${run.stdoutFile || '见 .dsh-pro/outputs/'})`;
        }
        r.data = {
          runId: run.runId, status: run.status, exitCode: run.exitCode,
          durationMs: run.durationMs, stdout, stderrFile: run.stderrFile, stderrLines: run.stderrLines, note: run.note,
        };
        log(`handoff ${run.runId} -> ${run.status}`);
      }
      // 确认流：桥接要求用户确认
      if (!r.ok && r.error && r.error.code === 'E_NEEDS_CONFIRM') {
        const allowed = await showConfirm(c.tool, c.args, r.error.message);
        if (allowed) {
          const r2 = await bridge('POST', '/tool', { tool: c.tool, args: c.args, workspace: state.workspace || undefined, confirmToken: r._confirmExtra });
          const j = (r2 && r2.json) || {};
          if (j.ok) { r.ok = true; r.data = j.data; delete r.error; }
          else { r.error = j.error || r.error; }
        } else {
          r.error = { code: 'E_USER_DENIED', message: '用户拒绝了本次操作确认' };
        }
      }
      const out = { seq: i, tool: c.tool, ok: r.ok, durationMs: r.durationMs };
      if (r.ok) out.data = r.data;
      else out.error = { code: r.error.code, message: String(r.error.message).slice(0, 2000) };
      results.push(out);
    }
    return results;
  }

  function showConfirm(tool, args, reason) {
    return new Promise((resolve) => {
      const box = document.getElementById('dshpro-confirm');
      if (!box) return resolve(false);
      box.style.display = 'block';
      document.getElementById('dshpro-confirm-text').textContent =
        `${tool}\n${JSON.stringify(args).slice(0, 300)}\n原因：${reason}`;
      const yes = document.getElementById('dshpro-confirm-yes');
      const no = document.getElementById('dshpro-confirm-no');
      const done = (v) => {
        box.style.display = 'none';
        yes.onclick = no.onclick = null;
        resolve(v);
      };
      yes.onclick = () => done(true);
      no.onclick = () => done(false);
    });
  }

  // ---------------------------------------------------------------------------
  // 协议消息
  // ---------------------------------------------------------------------------
  function buildProtocolMessage() {
    const tools = (state.tools && state.tools.tools) || [];
    const lines = tools.map((t) => `- ${t.name}：${t.description}。参数: ${JSON.stringify(t.params)}`);
    const roots = (state.health && state.health.allowedRoots) || [];
    return [
      '[DSH PRO 启用] 现在为你接入本地工具桥。你可以调用以下工具操作用户电脑上的工作区：',
      '',
      ...lines,
      '',
      '调用方法：在回复中每个调用输出为独立一行（可包在代码块内保证美观）：',
      MARK_OPEN + '{"tool":"工具名","args":{参数}}' + MARK_CLOSE,
      '每条消息最多 ' + MAX_CALLS_PER_MSG + ' 个调用，按顺序执行，结果会自动回传给你。',
      '所有路径均为相对工作区路径。已授权工作区：' + roots.join(' ; ') +
        '。可在 args 中用 workspace 指定（默认：' + (state.workspace || roots[0] || '') + '）。',
      '安全限制：写操作仅限授权目录；bash 仅允许安全白名单命令，部分操作需要用户在面板确认。',
      '执行策略（重要，决定对话干净程度）：',
      '- 轻量单步查看（1~2 个工具即可完成的读/搜）：直接调用工具。',
      '- 多步任务（探索、修改文件、跑命令、验证等超过 2 步）：不要逐步调用工具。先制定完整计划写入 planText，' +
        '然后只调用一次 dsh_handoff，随后立即结束回复（不要再输出任何工具调用）。' +
        '本地 agent 会自主执行整个计划（读文件/搜索/改代码/跑命令），完成后结果自动回传，你再向用户总结。',
      '- dsh_handoff 执行期间不要调用其他工具；结果到达前不要重复发起。',
      '任务全部完成后，单独一行输出：DSH:DONE:你的总结',
      '循环上限 ' + state.loopLimit + ' 轮。',
      '',
      '请先回复"已理解协议"，然后等待我的任务指令。',
    ].join('\n');
  }

  function buildResultMessage(results) {
    const blocks = results.map((r) => '```dsh-result\n' + JSON.stringify(r) + '\n```').join('\n\n');
    const remind =
      `[DSH PRO] 继续调用工具请输出 ${MARK_OPEN}{"tool":"…","args":{…}}${MARK_CLOSE}；` +
      `全部完成请单独一行输出 DSH:DONE:总结。剩余循环额度：${state.loopsLeft}。`;
    return '[DSH PRO 工具结果]\n\n' + blocks + '\n\n' + remind;
  }

  // ---------------------------------------------------------------------------
  // 核心循环：评估最新 AI 回复
  // ---------------------------------------------------------------------------
  async function evaluate() {
    // idleTrigger：就绪态下的"手动任务模式"——用户自己输入的任务，模型回复含有效调用时也要接手执行
    const idleTrigger = state.enabled && state.phase === 'idle';
    if (state.phase !== 'wait' && state.phase !== 'handshake_wait' && !idleTrigger) return;
    // 流式判断：任何阶段只要"停止按钮"可见就认为在生成。
    // 非握手阶段另要求页面静默 800ms（等回复渲染完）；握手阶段放宽——
    // DeepSeek 页面若有持续动画，lastMutationAt 会永远新鲜，evaluate 会被 isStreaming 永久饿死。
    if (stopButtonVisible()) return;
    if (state.phase !== 'handshake_wait' && Date.now() - state.lastMutationAt < 800) return;
    const el = findLastAssistant();
    if (!el) return;
    const key = keyOf(el);
    if (!key || key === state.lastProcessedKey || key === state.lastSentAssistantKey) return;

    const text = el.innerText || el.textContent || '';
    let calls = extractCalls(text);
    const doneMatch = text.match(DONE_RE);

    // 握手优先：handshake_wait 阶段只认"确认语"，绝不执行工具。
    // 必须放在 extractCalls 之后、执行分支之前——模型常回显协议里的 ⟦DSH⟧ 示例，
    // 那会被解析成 __invalid__ 调用，导致旧逻辑跳过握手分支直接去"执行"。
    // 全文匹配而非末尾 200 字：模型先说"已理解"再复述协议/补充说明时，末尾可能不含确认词。
    if (state.phase === 'handshake_wait') {
      state.lastProcessedKey = key;
      if (/已理解|理解协议|收到|好的|明白|确认|ok/i.test(text)) {
        state.enabled = true; // 协议生效：就绪态下用户手动任务也可触发执行
        log('协议握手成功，开始接受任务');
        setPhase('idle');
        state.fixups = 0;
      } else {
        log('模型已回复但未命中确认语，结尾："' + text.replace(/\s+/g, ' ').slice(-80) + '"（可点「诊断」看选择器命中）');
      }
      return;
    }

    if (idleTrigger) {
      // 手动任务模式只响应"有效调用"；模型回显协议示例（占位符非法 JSON）不触发
      const valid = calls.filter((c) => c.tool !== '__invalid__');
      state.lastProcessedKey = key;
      if (valid.length === 0) return;
      calls = valid;
      state.fixups = 0;
    }

    if (calls.length === 0) {
      if (doneMatch) {
        state.lastProcessedKey = key;
        log('任务完成：' + (doneMatch[1] || '').trim().slice(0, 120));
        finishRun();
        return;
      }
      // wait 阶段但无调用且无 DONE -> fixups
      state.lastProcessedKey = key;
      if (state.fixups < 2) {
        state.fixups++;
        log(`回复无有效调用（fixups ${state.fixups}/2）`);
        setPhase('sending');
        await sendText(
          '[DSH PRO] 上一条回复中没有检测到有效工具调用，也没有 DSH:DONE。请按协议格式重试：输出 ' +
          MARK_OPEN + '{"tool":"…","args":{…}}' + MARK_CLOSE + '，或单独一行 DSH:DONE:总结。'
        );
        setPhase('wait');
      } else {
        log('连续fixups失败，已暂停。请人工介入或点"重置"重新开始。');
        setPhase('idle');
        state.fixups = 0;
      }
      return;
    }

    // 有调用 -> 执行
    state.lastProcessedKey = key;
    state.fixups = 0;
    state.loopsLeft--;
    if (state.loopsLeft <= 0) {
      log('循环额度用尽，强制结束。可点"重置"继续。');
      setPhase('idle');
      state.loopsLeft = state.loopLimit;
      return;
    }
    const results = await executeCalls(calls);
    if (state.stopping) { state.stopping = false; setPhase('idle'); return; }
    setPhase('sending');
    const sent = await sendText(buildResultMessage(results));
    if (!sent) { setPhase('idle'); return; }
    setPhase('wait');
  }

  function finishRun() {
    state.loopsLeft = state.loopLimit;
    setPhase('idle');
  }

  // ---------------------------------------------------------------------------
  // Observer
  // ---------------------------------------------------------------------------
  let evalTimer = null;
  function scheduleEvaluate() {
    state.lastMutationAt = Date.now();
    if (evalTimer) clearTimeout(evalTimer);
    evalTimer = setTimeout(() => {
      evaluate().catch((e) => log('evaluate 异常: ' + e.message));
    }, 500);
  }

  // ---------------------------------------------------------------------------
  // 面板 UI
  // ---------------------------------------------------------------------------
  function buildPanel() {
    if (document.getElementById('dshpro-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'dshpro-panel';
    panel.className = 'dshpro-panel';
    panel.innerHTML = `
      <div class="dshpro-head" id="dshpro-head">
        <span class="dshpro-dot" id="dshpro-dot"></span>
        <span class="dshpro-title">DSH PRO</span>
        <span class="dshpro-phase" id="dshpro-phase">未启用</span>
        <span class="dshpro-toggle" id="dshpro-toggle">—</span>
      </div>
      <div class="dshpro-body" id="dshpro-body">
        <div class="dshpro-row">
          <button class="dshpro-btn" id="dshpro-test">连接测试</button>
          <button class="dshpro-btn primary" id="dshpro-enable">启用</button>
          <button class="dshpro-btn danger" id="dshpro-stop">停止</button>
          <button class="dshpro-btn" id="dshpro-reset">重置</button>
          <button class="dshpro-btn" id="dshpro-diag">诊断</button>
        </div>
        <div class="dshpro-label">默认工作区</div>
        <select class="dshpro-select" id="dshpro-workspace"><option value="">（连接后加载）</option></select>
        <div class="dshpro-label">剩余循环额度：<span id="dshpro-loops">-</span></div>
        <div class="dshpro-preview" id="dshpro-preview" style="display:none"></div>
        <div class="dshpro-confirm-box" id="dshpro-confirm" style="display:none">
          <div class="dshpro-confirm-title">高风险操作确认</div>
          <pre id="dshpro-confirm-text" style="white-space:pre-wrap;font:11px Consolas;max-height:120px;overflow:auto"></pre>
          <div class="dshpro-row">
            <button class="dshpro-btn danger" id="dshpro-confirm-yes">允许一次</button>
            <button class="dshpro-btn" id="dshpro-confirm-no">拒绝</button>
          </div>
        </div>
        <div class="dshpro-log" id="dshpro-log"></div>
        <div class="dshpro-row">
          <button class="dshpro-btn" id="dshpro-settings-toggle">设置</button>
        </div>
        <div class="dshpro-settings" id="dshpro-settings" style="display:none">
          <div class="dshpro-label">桥接 Token</div>
          <input class="dshpro-input" id="dshpro-token" placeholder="pair.ps1 生成的 token（自动复制到剪贴板）" />
          <div class="dshpro-label">循环上限（5-30）</div>
          <input class="dshpro-input" id="dshpro-looplimit" type="number" min="5" max="30" />
          <div class="dshpro-label">自定义选择器（JSON，可选，覆盖内置候选）</div>
          <input class="dshpro-input" id="dshpro-sel" placeholder='{"input":"textarea#x","sendButton":"button.y"}' />
          <div class="dshpro-row">
            <button class="dshpro-btn" id="dshpro-save">保存设置</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(panel);

    document.getElementById('dshpro-toggle').onclick = (e) => {
      e.stopPropagation();
      panel.classList.toggle('dshpro-min');
      document.getElementById('dshpro-toggle').textContent = panel.classList.contains('dshpro-min') ? '+' : '—';
    };
    document.getElementById('dshpro-head').onclick = () => {
      panel.classList.toggle('dshpro-min');
      document.getElementById('dshpro-toggle').textContent = panel.classList.contains('dshpro-min') ? '+' : '—';
    };
    document.getElementById('dshpro-test').onclick = doConnectTest;
    document.getElementById('dshpro-enable').onclick = doEnable;
    document.getElementById('dshpro-stop').onclick = doStop;
    document.getElementById('dshpro-reset').onclick = doReset;
    document.getElementById('dshpro-diag').onclick = doDiagnose;
    document.getElementById('dshpro-settings-toggle').onclick = () => {
      const s = document.getElementById('dshpro-settings');
      s.style.display = s.style.display === 'none' ? 'block' : 'none';
    };
    document.getElementById('dshpro-save').onclick = saveSettings;
    document.getElementById('dshpro-workspace').onchange = (e) => {
      state.workspace = e.target.value;
      chrome.storage.local.set({ workspace: state.workspace });
    };
  }

  function refreshLoops() {
    const el = document.getElementById('dshpro-loops');
    if (el) el.textContent = `${state.loopsLeft}/${state.loopLimit}`;
  }

  async function doConnectTest() {
    const dot = document.getElementById('dshpro-dot');
    dot.className = 'dshpro-dot busy';
    const r = await bridge('GET', '/health');
    if (r && r.ok && r.json && r.json.ok) {
      state.connected = true;
      state.health = r.json;
      state.tools = (await bridge('GET', '/tools')).json;
      log('桥接已连接：' + r.json.allowedRoots.join(' ; '));
      // 工作区下拉
      const sel = document.getElementById('dshpro-workspace');
      sel.innerHTML = '';
      for (const root of r.json.allowedRoots) {
        const opt = document.createElement('option');
        opt.value = root;
        opt.textContent = root;
        sel.appendChild(opt);
      }
      if (!state.workspace || !r.json.allowedRoots.includes(state.workspace)) {
        state.workspace = r.json.allowedRoots[0] || '';
      }
      sel.value = state.workspace;
      chrome.storage.local.set({ workspace: state.workspace });
      const dsh = r.json.dsh || {};
      log('dsh 运行时：' + (dsh.binFound ? '已找到' : '未找到（handoff 不可用）'));
    } else {
      state.connected = false;
      log('连接失败：' + ((r && r.json && r.json.error && r.json.error.message) || (r && r.error) || 'HTTP ' + (r && r.status)));
    }
    updateDot();
  }

  async function doEnable() {
    if (!state.connected) await doConnectTest();
    if (!state.connected) { log('请先连接桥接服务（检查 token 与 start-dsh-pro.cmd）'); return; }
    state.loopsLeft = state.loopLimit;
    refreshLoops();
    state.handshakeAt = Date.now();
    state.handshakeHinted = false;
    setPhase('handshake_wait');
    const sent = await sendText(buildProtocolMessage());
    if (!sent) { setPhase('off'); return; }
    log('协议消息已发送，等待模型确认…');
  }

  async function doStop() {
    state.stopping = true;
    const runId = state.activeRunId;
    if (runId) {
      try {
        const r = await bridge('POST', `/handoff/${runId}/cancel`);
        const st = r && r.json && (r.json.status || (r.json.ok ? 'cancelled' : ''));
        log(`handoff ${runId} 取消请求已发送（${st || '处理中'}），本地进程将被终止`);
      } catch (e) {
        log('取消请求发送失败：' + e);
      }
    } else {
      log('停止请求已发出（当前没有进行中的 handoff）');
    }
    setPhase(state.connected ? 'idle' : 'off');
  }

  function doReset() {
    state.fixups = 0;
    state.lastProcessedKey = '';
    state.lastSentAssistantKey = '';
    state.loopsLeft = state.loopLimit;
    state.stopping = false;
    refreshLoops();
    setPhase(state.connected ? 'idle' : 'off');
    log('已重置循环状态');
  }

  // 诊断：报告每个选择器候选的命中数与关键状态，用于页面改版时定位断点
  function doDiagnose() {
    const lines = [];
    lines.push(`state: connected=${state.connected} enabled=${state.enabled} phase=${state.phase} loops=${state.loopsLeft}/${state.loopLimit}`);
    for (const kind of ['assistantMarkdown', 'messageContainer', 'input', 'sendButton', 'stopButton']) {
      const list = selList(kind);
      const counts = list.map((s) => {
        try {
          return `${s}(${document.querySelectorAll(s).length})`;
        } catch {
          return `${s}(ERR)`;
        }
      });
      lines.push(`[${kind}] ${counts.join(' | ') || '(无候选)'}`);
    }
    const a = findLastAssistant();
    if (a) {
      const cls = (a.className || '').toString().slice(0, 120);
      const tail = (a.innerText || a.textContent || '').replace(/\s+/g, ' ').slice(-60);
      lines.push(`assistant: <${a.tagName.toLowerCase()} class="${cls}"> tail="${tail}"`);
    } else {
      lines.push('assistant: 未找到（这是关键断点——换到有对话消息的会话再点诊断，或填自定义选择器）');
    }
    const inp = findInput();
    lines.push(inp ? `input: <${inp.tagName.toLowerCase()} id="${inp.id || ''}" class="${(inp.className || '').toString().slice(0, 80)}">` : 'input: 未找到');
    const btn = findSendButton();
    lines.push(btn ? `sendButton: <${btn.tagName.toLowerCase()} class="${(btn.className || '').toString().slice(0, 80)}" disabled=${btn.disabled}>` : 'sendButton: 未找到');
    const cont = lastVisible(selList('messageContainer'));
    lines.push(cont ? `container: <${cont.tagName.toLowerCase()} class="${(cont.className || '').toString().slice(0, 80)}">` : 'container: 未找到（退化为 body 观察）');
    log('诊断结果：\n' + lines.join('\n'));
  }

  async function saveSettings() {
    const token = document.getElementById('dshpro-token').value.trim();
    const loopLimit = parseInt(document.getElementById('dshpro-looplimit').value, 10);
    const selRaw = document.getElementById('dshpro-sel').value.trim();
    const patch = {};
    if (token) patch.token = token;
    if (!Number.isNaN(loopLimit) && loopLimit >= 5 && loopLimit <= 30) {
      patch.loopLimit = loopLimit;
      state.loopLimit = loopLimit;
      state.loopsLeft = Math.min(state.loopsLeft, loopLimit);
    }
    if (selRaw) {
      try {
        state.customSelectors = JSON.parse(selRaw);
        patch.customSelectors = state.customSelectors;
      } catch (e) {
        log('自定义选择器不是合法 JSON，未保存');
      }
    }
    await chrome.storage.local.set(patch);
    state.token = patch.token || state.token;
    refreshLoops();
    log('设置已保存');
  }

  // ---------------------------------------------------------------------------
  // 初始化
  // ---------------------------------------------------------------------------
  async function init() {
    buildPanel();
    const d = await chrome.storage.local.get(['token', 'loopLimit', 'customSelectors', 'workspace']);
    state.token = d.token || '';
    if (d.loopLimit) state.loopLimit = d.loopLimit;
    state.customSelectors = d.customSelectors || null;
    if (d.workspace) state.workspace = d.workspace;
    state.loopsLeft = state.loopLimit;
    refreshLoops();
    setPhase('off');

    const inp = document.getElementById('dshpro-token');
    if (inp) inp.value = state.token;
    const ll = document.getElementById('dshpro-looplimit');
    if (ll) ll.value = String(state.loopLimit);

    // 页面加载后自动尝试连接（token 已配对则直接就绪）
    if (state.token) {
      await doConnectTest();
    } else {
      log('首次使用：运行 scripts\\pair.ps1 生成并复制 token，然后在设置里粘贴保存，点"连接测试"。');
    }

    const obs = new MutationObserver(() => scheduleEvaluate());
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    scheduleEvaluate();

    // 看门狗：Observer 可能因持续 DOM 动画被饿死（isStreaming 永远真），
    // 定时兜底跑一次 evaluate，并在握手超时时给出可操作的提示。
    setInterval(() => {
      evaluate().catch(() => {});
      if (state.phase === 'handshake_wait' && state.handshakeAt && !state.handshakeHinted &&
          Date.now() - state.handshakeAt > 120000) {
        state.handshakeHinted = true;
        log('握手超过 120s 未确认：请确认 DeepSeek 页面确已回复；点「诊断」查看选择器命中；必要时在设置里填自定义选择器。');
      }
    }, 2500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
