'use strict';
// DSH PRO - handoff.js
// 计划落盘 .dsh-pro/ -> spawn `dsh --profile headless "…"` -> 输出采集 -> runs/<runId>.json 持久真源。
// 串行队列：同时最多 1 个 dsh handoff。扩展通过 GET /handoff/:runId 轮询。

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ToolError } = require('./guard');

const STDOUT_MAX = 256 * 1024;   // stdout 内存上限，超限落盘
const STDERR_MAX = 256 * 1024;

// ---------------------------------------------------------------------------
// node / dsh 可执行定位（复用 DeepSeek Harness 桌面壳的策略）
// ---------------------------------------------------------------------------
function resolveNodeExec(config) {
  // 1) 系统 node（与 dsh 原生模块 ABI 一致，桌面壳同款逻辑）
  try {
    const p = spawnSync('node', ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    if (p.status === 0) return { cmd: 'node', env: { ...process.env }, source: 'system node' };
  } catch {}
  // 2) 回退：Electron as node（开发环境 dsh-runtime 同级）
  const electronCandidates = [
    path.join('D:', path.sep, 'DeepSeek Harness', 'harness-desktop', 'node_modules', 'electron', 'dist', 'electron.exe'),
    'C:\\Program Files\\Microsoft\\VS Code\\Code.exe',
  ];
  for (const c of electronCandidates) {
    if (fs.existsSync(c)) {
      return { cmd: c, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, source: 'electron-as-node' };
    }
  }
  return null;
}

function resolveDshBin(config) {
  const candidates = [];
  if (config.dshBin) candidates.push(String(config.dshBin));
  candidates.push(
    path.join('D:', path.sep, 'DeepSeek Harness', 'harness-desktop', 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  );
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {}
  }
  return null;
}

function dshProbe(config) {
  const bin = resolveDshBin(config);
  const node = resolveNodeExec(config);
  return { binFound: Boolean(bin && node), bin, node };
}

// ---------------------------------------------------------------------------
// 状态落盘
// ---------------------------------------------------------------------------
function slugify(text, fallback) {
  const s = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || fallback;
}

function tsCompact(d) {
  return d.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function stateDir(workspace) {
  return path.join(workspace, '.dsh-pro');
}

function writeStatus(workspace, run) {
  const lines = [
    '# DSH PRO agent-status',
    '',
    `- status: ${run.status}`,
    `- runId: ${run.runId}`,
    `- planFile: ${run.planFileRel}`,
    `- workspace: ${run.workspace}`,
    `- startedAt: ${run.startedAt}`,
    run.finishedAt ? `- finishedAt: ${run.finishedAt}` : null,
    run.exitCode !== undefined && run.exitCode !== null ? `- exitCode: ${run.exitCode}` : null,
    run.durationMs !== undefined ? `- durationMs: ${run.durationMs}ms` : null,
    run.note ? `- note: ${run.note}` : null,
    '',
  ].filter((x) => x !== null);
  fs.writeFileSync(path.join(stateDir(workspace), 'agent-status.md'), lines.join('\n'), 'utf8');
}

function appendLog(workspace, obj) {
  try {
    fs.appendFileSync(path.join(stateDir(workspace), 'execution-log.jsonl'), JSON.stringify(obj) + '\n', 'utf8');
  } catch {}
}

// ---------------------------------------------------------------------------
// Handoff 管理器（单例，由 server.js 持有）
// ---------------------------------------------------------------------------
class HandoffManager {
  constructor(config) {
    this.config = config;
    this.runs = new Map(); // runId -> run（内存真源；完成后持久化到 runs/<runId>.json）
    this.current = null;   // 串行：同时最多 1 个，忙时 E_BUSY
    this.persistIndex = this.config.allowedRoots.map((r) => path.join(r, '.dsh-pro', 'runs'));
  }

  /** 启动一次 handoff（同步返回 runId，异步执行）。 */
  start({ workspace, planText, taskNote, timeoutMs }) {
    if (this.current) {
      throw new ToolError('E_BUSY', '已有 handoff 正在执行（串行队列），请稍后再试');
    }
    const t = Math.min(
      Math.max(30000, Number(timeoutMs) || this.config.handoffTimeoutMs),
      this.config.handoffTimeoutMaxMs
    );
    const probe = dshProbe(this.config);
    if (!probe.binFound) {
      throw new ToolError(
        'E_INTERNAL',
        `dsh 运行时未找到（bin/node）。probe=${JSON.stringify(probe)}。请确认 DeepSeek Harness 桌面版已安装，或在 config.json 配置 dshBin。`
      );
    }

    const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const sd = stateDir(workspace);
    fs.mkdirSync(path.join(sd, 'plans'), { recursive: true });
    fs.mkdirSync(path.join(sd, 'outputs'), { recursive: true });
    fs.mkdirSync(path.join(sd, 'runs'), { recursive: true });

    const stamp = tsCompact(new Date());
    const planName = `${stamp}-${slugify(taskNote, 'plan')}.md`;
    const planAbs = path.join(sd, 'plans', planName);
    fs.writeFileSync(planAbs, planText, 'utf8');
    // current-plan.md 为最近一次计划的指针副本
    fs.writeFileSync(path.join(sd, 'current-plan.md'), planText, 'utf8');

    const run = {
      runId,
      workspace,
      planFileRel: `.dsh-pro/plans/${planName}`,
      planAbs,
      status: 'running',
      startedAt: new Date().toISOString(),
      timeoutMs: t,
      exitCode: null,
      stdout: '',
      stdoutTruncated: false,
      stdoutFile: null,
      stderrFile: null,
      stderrLines: 0,
      durationMs: null,
      note: taskNote || '',
      child: null,
    };
    this.runs.set(runId, run);
    this.current = run;
    this.persist(run);
    writeStatus(workspace, run);
    appendLog(workspace, { ts: run.startedAt, event: 'start', runId, planFile: run.planFileRel, timeoutMs: t });

    // 任务文本：让 dsh 读取计划文件并执行（CWD=workspace 即工作区根）
    const taskText =
      `读取计划文件 ${run.planFileRel.replace(/\\/g, '/')} 并完整执行其中的步骤。` +
      `当前目录就是工作区根目录。` +
      (taskNote ? `任务备注：${taskNote}。` : '') +
      `完成后输出：变更文件清单与每处变更的简述。`;

    const { bin, node: nodeExec } = probe;
    let child;
    try {
      // dsh 沙箱要求 temp 在 workspace 之外；本机 TMP 可能被项目指到 workspace 内
      // （如 HiSpark 的 D:\HiSpark_Studio\temp），故给 dsh 子进程单独覆盖到系统临时目录，
      // 避免 "Windows ACL temp root must be outside the workspace"
      const env = { ...nodeExec.env, TMP: require('os').tmpdir(), TEMP: require('os').tmpdir() };
      child = spawn(nodeExec.cmd, [bin, '--profile', 'headless', taskText], {
        cwd: workspace,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      run.status = 'failed';
      run.note = `spawn 失败：${err.message}`;
      run.finishedAt = new Date().toISOString();
      this.finalize(run);
      throw new ToolError('E_INTERNAL', `dsh 启动失败：${err.message}`);
    }
    run.child = child;

    let stdoutBuf = Buffer.alloc(0);
    let stderrBuf = Buffer.alloc(0);
    child.stdout.on('data', (c) => {
      if (stdoutBuf.length < STDOUT_MAX) {
        stdoutBuf = Buffer.concat([stdoutBuf, c]);
        if (stdoutBuf.length > STDOUT_MAX) {
          stdoutBuf = stdoutBuf.slice(0, STDOUT_MAX);
          run.stdoutTruncated = true;
        }
      } else {
        run.stdoutTruncated = true;
      }
      // 实时尾部：仅供扩展面板显示进度，不回传给模型（防误读半截输出）
      run.stdoutLive = stdoutBuf.toString('utf8').slice(-1500);
    });
    child.stderr.on('data', (c) => {
      if (stderrBuf.length < STDERR_MAX) {
        stderrBuf = Buffer.concat([stderrBuf, c]);
        if (stderrBuf.length > STDERR_MAX) stderrBuf = stderrBuf.slice(0, STDERR_MAX);
      }
    });

    run.timer = setTimeout(() => {
      if (run.status === 'running') {
        run.note = `超时（${t}ms），已终止进程`;
        this.kill(run, 'timeout');
      }
    }, t);

    child.on('error', (err) => {
      run.note = `进程错误：${err.message}`;
      if (run.status === 'running') this.finish(run, -1, stdoutBuf, stderrBuf);
    });
    child.on('close', (code) => {
      // 超时/取消路径已预置状态，finish 内会保留
      this.finish(run, code, stdoutBuf, stderrBuf);
    });

    return { runId, planFile: run.planFileRel, status: run.status, timeoutMs: t };
  }

  kill(run, statusAfter) {
    try {
      spawnSync('taskkill', ['/PID', String(run.child.pid), '/T', '/F'], { windowsHide: true });
    } catch {}
    run.status = statusAfter; // 'timeout' | 'cancelled'
  }

  finish(run, code, stdoutBuf, stderrBuf) {
    if (run._finished) return;
    run._finished = true;
    clearTimeout(run.timer);
    run.exitCode = code;
    run.status = run.status === 'timeout' || run.status === 'cancelled' ? run.status : code === 0 ? 'done' : 'failed';
    run.finishedAt = new Date().toISOString();
    run.durationMs = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
    run.stdout = stdoutBuf.toString('utf8');

    const outsDir = path.join(stateDir(run.workspace), 'outputs');
    try {
      const stamp = tsCompact(new Date());
      if (run.stdoutTruncated || run.stdout.length > 64 * 1024) {
        const f = path.join(outsDir, `${stamp}-stdout.txt`);
        fs.writeFileSync(f, stdoutBuf, 'utf8');
        run.stdoutFile = `.dsh-pro/outputs/${stamp}-stdout.txt`;
      }
      if (stderrBuf.length > 0) {
        const f = path.join(outsDir, `${stamp}-stderr.txt`);
        fs.writeFileSync(f, stderrBuf, 'utf8');
        run.stderrFile = `.dsh-pro/outputs/${stamp}-stderr.txt`;
        run.stderrLines = stderrBuf.toString('utf8').split('\n').filter(Boolean).length;
      }
    } catch {}
    this.finalize(run);
  }

  finalize(run) {
    run.child = null;
    this.current = null;
    this.persist(run);
    writeStatus(run.workspace, run);
    appendLog(run.workspace, {
      ts: run.finishedAt || new Date().toISOString(),
      event: 'end',
      runId: run.runId,
      status: run.status,
      exitCode: run.exitCode,
      durationMs: run.durationMs,
      stdoutBytes: run.stdout ? Buffer.byteLength(run.stdout, 'utf8') : 0,
      note: run.note || undefined,
    });
  }

  persist(run) {
    try {
      const data = { ...run, child: undefined, timer: undefined };
      delete data.child;
      delete data.timer;
      delete data.stdoutLive; // 瞬态进度，不持久化
      fs.writeFileSync(path.join(stateDir(run.workspace), 'runs', `${run.runId}.json`), JSON.stringify(data, null, 2), 'utf8');
    } catch {}
  }

  /** 查询：内存优先，桥接重启后回退读各 workspace 的 runs/<runId>.json。 */
  get(runId) {
    const mem = this.runs.get(runId);
    if (mem) return this.serialize(mem);
    for (const dir of this.persistIndex) {
      const f = path.join(dir, `${runId}.json`);
      try {
        if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
      } catch {}
    }
    return null;
  }

  serialize(run) {
    const out = {
      runId: run.runId,
      status: run.status,
      workspace: run.workspace,
      planFile: run.planFileRel,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt || null,
      durationMs: run.durationMs ?? null,
      exitCode: run.exitCode ?? null,
      stdout: run.stdout || '',
      stdoutTruncated: Boolean(run.stdoutTruncated),
      stdoutFile: run.stdoutFile || null,
      stderrFile: run.stderrFile || null,
      stderrLines: run.stderrLines || 0,
      note: run.note || '',
      timeoutMs: run.timeoutMs ?? null,
    };
    if (run.status === 'running') {
      out.elapsedMs = Date.now() - Date.parse(run.startedAt);
      out.liveTail = run.stdoutLive || ''; // 面板进度用；模型侧仍只拿终态
      out.stdout = ''; // 运行中不回传半截输出，避免模型误读
    }
    return out;
  }

  cancel(runId) {
    const run = this.runs.get(runId);
    if (!run) {
      const persisted = this.get(runId);
      if (persisted && persisted.status !== 'running') return { ok: true, status: persisted.status, note: '已结束，无需取消' };
      throw new ToolError('E_ARGS_INVALID', `未找到运行中的 handoff：${runId}`);
    }
    if (run.status !== 'running') return { ok: true, status: run.status };
    run.status = 'cancelled';
    run.note = '用户取消';
    this.kill(run, 'cancelled');
    run.finishedAt = new Date().toISOString();
    run.durationMs = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
    this.finalize(run);
    return { ok: true, status: 'cancelled' };
  }
}

module.exports = { HandoffManager, dshProbe, resolveNodeExec, resolveDshBin };
