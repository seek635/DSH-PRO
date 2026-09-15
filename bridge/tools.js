'use strict';
// DSH PRO - tools.js
// 10 个工具实现：dsh_tree / dsh_read / dsh_write / dsh_edit / dsh_search / dsh_bash /
//                dsh_git_status / dsh_git_diff / dsh_handoff / dsh_log
// 所有路径均为 workspace 相对路径，经 guard.validatePath 校验。
// 每次调用经 runTool 统一写执行日志 .dsh-pro/logs/execution-log.jsonl（参照 CodexPro 模式）。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const {
  ToolError,
  resolveWorkspace,
  validatePath,
  looksBinaryByExt,
  sniffBinary,
} = require('./guard');

const READ_MAX_BYTES = 512 * 1024;
const RANGE_SCAN_MAX_BYTES = 2 * 1024 * 1024; // 带 offset/limit 时允许的扫描上限（参照 CodexPro textScanByteLimit）
const BASH_OUT_MAX = 64 * 1024;
const TREE_MAX_ENTRIES = 2000;
const SEARCH_MAX_FILES = 5000;
const DIFF_MAX_BYTES_DEFAULT = 48000;
const LOG_REL_PATH = '.dsh-pro/logs/execution-log.jsonl';

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// CodexPro 风格行号：右侧对齐，" 12 | code"，方便模型精确引用行号
function withLineNumbers(lines, startLine) {
  const width = String(startLine + lines.length - 1).length;
  return lines.map((line, idx) => `${String(startLine + idx).padStart(width, ' ')} | ${line}`).join('\n');
}

// ---------------------------------------------------------------------------
// 工具元数据（GET /tools 的数据源；扩展据此生成协议消息，防两端清单漂移）
// ---------------------------------------------------------------------------
const TOOL_DEFS = [
  { name: 'dsh_tree', description: '列出目录树（跳过 node_modules/.git）', params: { path: 'string?', depth: 'int? 默认3' } },
  { name: 'dsh_read', description: '读取文本文件片段（1-based 行，带行号输出；返回 sha256 供编辑校验）', params: { path: 'string', offset: 'int? 默认1', limit: 'int? 默认200' } },
  { name: 'dsh_write', description: '写入文件（整文件覆盖，自动建父目录）', params: { path: 'string', content: 'string', expectedSha256: 'string? 若提供且与现有内容不符则拒绝（防陈旧覆盖）' } },
  { name: 'dsh_edit', description: '精确替换文件中唯一出现的片段', params: { path: 'string', oldText: 'string', newText: 'string', expectedSha256: 'string? dsh_read 返回的 sha256，文件被改过时拒绝编辑' } },
  { name: 'dsh_search', description: '在文件内容中搜索（纯文本或正则）', params: { query: 'string', path: 'string?', regex: 'bool?', caseSensitive: 'bool?', maxResults: 'int? 默认50' } },
  { name: 'dsh_bash', description: '在 workspace 执行安全白名单命令', params: { command: 'string', timeoutMs: 'int? 默认20000' } },
  { name: 'dsh_git_status', description: 'git status（只读 porcelain）', params: { path: 'string?' } },
  { name: 'dsh_git_diff', description: 'git diff（只读，超大自动落盘）', params: { path: 'string?', staged: 'bool?', maxBytes: 'int? 默认48000' } },
  { name: 'dsh_handoff', description: '【多步任务推荐】本地 agent（dsh headless）自主闭环执行完整计划：自己读文件/搜索/修改/跑命令，期间无需你逐步驱动，完成后只回传最终结果。planText 必须是自包含的完整计划（含验收标准）。调用后请立即结束回复，不要再输出其他工具调用', params: { planText: 'string 完整计划文本', workspace: 'string?', taskNote: 'string? 任务标题（用于日志命名）', timeoutMs: 'int? 默认300000，上限1800000' } },
  { name: 'dsh_log', description: '读取执行日志尾部（.dsh-pro/logs/execution-log.jsonl，每次工具调用自动记录）', params: { lines: 'int? 默认100，上限1000' } },
];

// ---------------------------------------------------------------------------
// bash 安全层：白名单前缀 + 无条件黑名单 + 元字符封禁
// ---------------------------------------------------------------------------
const BASH_META_CHARS = /[|&<>;`\n\r$]/;

const BASH_BLACKLIST_RE = new RegExp(
  [
    '\\b(rm|del|rd|rmdir|mv|move|cp|copy|dd|shutdown|taskkill|tskill|reg|netsh|setx|sudo',
    'curl|wget|powershell|pwsh|iwr|irm|invoke-expression|invoke-webrequest|ssh|scp|sftp|ftp',
    'certutil|bitsadmin|mshta|rundll32|regsvr32|schtasks|at|sc)\\b',
    '\\bformat\\s+[a-z]:',
    '\\bnet\\s+(use|user|localgroup|share|stop|start|session|file|time|accounts)\\b',
    '\\bgit\\s+(push|commit|checkout|switch|reset|clean|rebase|merge|stash|restore|rm|mv|apply|cherry-pick|revert|tag|am|filter-branch|bisect)\\b',
  ].join('|'),
  'i'
);

function checkBashCommand(command) {
  if (typeof command !== 'string' || command.trim() === '') {
    throw new ToolError('E_ARGS_INVALID', 'command 必须为非空字符串');
  }
  if (command.length > 2000) throw new ToolError('E_ARGS_INVALID', '命令过长（>2000 字符）');
  if (BASH_META_CHARS.test(command)) {
    throw new ToolError('E_BASH_BLOCKED', '命令含被禁止的元字符（| & > < ; ` $ 换行）');
  }
  if (BASH_BLACKLIST_RE.test(command)) {
    throw new ToolError('E_BASH_BLOCKED', `命令命中黑名单：${command.slice(0, 120)}`);
  }
  const trimmed = command.trim().replace(/\s+/g, ' ');
  const lower = trimmed.toLowerCase();
  const tokens = lower.split(' ');
  const head = tokens[0];
  const second = tokens[1] || '';

  const plainHeads = new Set(['pwd', 'dir', 'ls', 'tree', 'type', 'where', 'whoami']);
  const gitReadOnly = new Set(['status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'ls-files', 'describe', 'remote']);
  const pkgHeads = new Set(['npm', 'pnpm', 'yarn', 'bun']);
  const pkgSecondOk = new Set(['test', 'run', 'build', 'lint', 'typecheck', 'check', '--version', '-v', 'ls', 'list', 'why', 'outdated', 'exec']);
  const versionOnly = new Set(['--version', '-v']);
  const npxTools = new Set(['tsc', 'eslint', 'prettier', 'vitest', 'jest', 'mocha']);

  let allowed = false;
  if (plainHeads.has(head)) allowed = true;
  else if (head === 'git' && gitReadOnly.has(second)) allowed = true;
  else if (pkgHeads.has(head) && pkgSecondOk.has(second)) allowed = true;
  else if ((head === 'node' || head === 'npm' || head === 'npx') && versionOnly.has(second)) allowed = true;
  else if (head === 'npx' && npxTools.has(second)) allowed = true;
  else if (head === 'tsc' || head === 'eslint') allowed = true;

  if (allowed) return { verdict: 'allow' };
  return { verdict: 'confirm', reason: `命令不在安全白名单内（黑名单外，需用户确认）：${trimmed.slice(0, 120)}` };
}

// ---------------------------------------------------------------------------
// 各工具实现。ctx = { config, workspace, confirmed:boolean }
// ---------------------------------------------------------------------------

function walkTree(root, rel, depth, out) {
  const abs = path.join(root, rel);
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
  for (const e of entries) {
    if (out.count >= TREE_MAX_ENTRIES) {
      out.truncated = true;
      return;
    }
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.count++;
      out.lines.push(`${'  '.repeat(depth)}${e.name}/`);
      if (depth + 1 < out.maxDepth) walkTree(root, childRel, depth + 1, out);
    } else if (e.isFile()) {
      out.count++;
      out.lines.push(`${'  '.repeat(depth)}${e.name}`);
    }
  }
}

function toolTree(ctx, args) {
  const root = resolveWorkspace(ctx.config, ctx.workspace);
  const relPath = args.path !== undefined ? String(args.path) : '.';
  const { abs } = validatePath(ctx.config, ctx.workspace, relPath, false);
  const st = fs.statSync(abs);
  const base = st.isDirectory() ? relPath : path.dirname(relPath);
  const out = { lines: [], count: 0, maxDepth: Math.min(Number(args.depth) || 3, 8), truncated: false };
  walkTree(root, base === '.' ? '' : base, 0, out);
  return {
    tree: out.lines.join('\n') || '(空目录)',
    fileCount: out.count,
    truncated: out.truncated,
  };
}

function toolRead(ctx, args) {
  const { abs, posixRel } = validatePath(ctx.config, ctx.workspace, String(args.path), false);
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new ToolError('E_ARGS_INVALID', `文件不存在：${posixRel}`);
  }
  if (st.isDirectory()) throw new ToolError('E_ARGS_INVALID', `目标是目录，请用 dsh_tree：${posixRel}`);
  // 整读上限 READ_MAX_BYTES；带 offset/limit 范围读取时放宽到 RANGE_SCAN_MAX_BYTES（CodexPro 模式）
  const hasRange = args.offset !== undefined || args.limit !== undefined;
  if (st.size > READ_MAX_BYTES && !(hasRange && st.size <= RANGE_SCAN_MAX_BYTES)) {
    throw new ToolError('E_FORBIDDEN_PATH', `文件超过读取上限（${READ_MAX_BYTES} 字节${hasRange ? `，范围读取上限 ${RANGE_SCAN_MAX_BYTES} 字节` : ''}）：${posixRel}`);
  }
  if (looksBinaryByExt(abs)) throw new ToolError('E_BINARY_FILE', `疑似二进制文件（按扩展名）：${posixRel}`);
  const buf = fs.readFileSync(abs);
  if (sniffBinary(buf)) throw new ToolError('E_BINARY_FILE', `检测到二进制内容（空字节/BOM），拒绝读取：${posixRel}`);
  const text = buf.toString('utf8');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const totalLines = lines.length;
  let offset = Math.max(1, Number(args.offset) || 1);
  let limit = Math.min(Math.max(1, Number(args.limit) || 200), 2000);
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  return {
    file: posixRel,
    content: withLineNumbers(slice, offset),
    startLine: offset,
    endLine: offset + slice.length - 1,
    totalLines,
    truncated: offset - 1 + slice.length < totalLines,
    sha256: sha256(text),
  };
}

function toolWrite(ctx, args) {
  if (typeof args.content !== 'string') throw new ToolError('E_ARGS_INVALID', 'content 必须为字符串');
  if (args.content.length > 2 * 1024 * 1024) throw new ToolError('E_ARGS_INVALID', 'content 超过 2MB 上限');
  const { abs, posixRel } = validatePath(ctx.config, ctx.workspace, String(args.path), true);
  const existed = fs.existsSync(abs);
  if (existed && args.expectedSha256) {
    const cur = fs.readFileSync(abs, 'utf8');
    if (sha256(cur) !== String(args.expectedSha256).toLowerCase()) {
      throw new ToolError('E_STALE_FILE', `文件自读取后已被修改（sha256 不符），请重新 dsh_read 再写：${posixRel}`);
    }
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, args.content, 'utf8');
  return { bytesWritten: Buffer.byteLength(args.content, 'utf8'), created: !existed, file: posixRel, sha256: sha256(args.content) };
}

function toolEdit(ctx, args) {
  if (typeof args.oldText !== 'string' || args.oldText === '') throw new ToolError('E_ARGS_INVALID', 'oldText 必须为非空字符串');
  if (typeof args.newText !== 'string') throw new ToolError('E_ARGS_INVALID', 'newText 必须为字符串');
  const { abs, posixRel } = validatePath(ctx.config, ctx.workspace, String(args.path), true);
  if (!fs.existsSync(abs)) throw new ToolError('E_ARGS_INVALID', `文件不存在：${posixRel}`);
  const text = fs.readFileSync(abs, 'utf8');
  if (args.expectedSha256 && sha256(text) !== String(args.expectedSha256).toLowerCase()) {
    throw new ToolError('E_STALE_FILE', `文件自读取后已被修改（sha256 不符），请重新 dsh_read 再编辑：${posixRel}`);
  }
  const parts = text.split(args.oldText);
  if (parts.length === 1) {
    throw new ToolError('E_ARGS_INVALID', `oldText 在文件中未找到（0 次）：${posixRel}`);
  }
  if (parts.length > 2) {
    throw new ToolError('E_ARGS_INVALID', `oldText 在文件中出现 ${parts.length - 1} 次，必须唯一。请附带更多上下文使其唯一：${posixRel}`);
  }
  const after = text.replace(args.oldText, args.newText);
  fs.writeFileSync(abs, after, 'utf8');
  return { replaced: 1, file: posixRel, sha256: sha256(after) };
}

const SEARCH_SKIP_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'zip', 'gz', 'tar', '7z', 'rar',
  'exe', 'dll', 'so', 'dylib', 'pdf', 'mp3', 'mp4', 'avi', 'mov', 'wav', 'flac',
  'wasm', 'woff', 'woff2', 'ttf', 'eot', 'otf', 'bin', 'db', 'sqlite', 'sqlite3',
  'node', 'pyc', 'class', 'jar', 'iso', 'msi', 'map', 'min.js',
]);

function searchWalk(dir, base, matcher, out) {
  if (out.matches.length >= out.maxResults || out.filesScanned >= SEARCH_MAX_FILES) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.matches.length >= out.maxResults || out.filesScanned >= SEARCH_MAX_FILES) return;
    const abs = path.join(dir, e.name);
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === '.dsh-pro') continue;
      searchWalk(abs, rel, matcher, out);
    } else if (e.isFile()) {
      const ext = e.name.split('.').pop().toLowerCase();
      if (SEARCH_SKIP_EXT.has(ext)) continue;
      out.filesScanned++;
      let text;
      try {
        const st = fs.statSync(abs);
        if (st.size > 1024 * 1024) continue;
        const buf = fs.readFileSync(abs);
        if (sniffBinary(buf)) continue;
        text = buf.toString('utf8');
      } catch {
        continue;
      }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (matcher(lines[i])) {
          out.matches.push({ file: rel, line: i + 1, text: lines[i].slice(0, 240).replace(/\t/g, '  ') });
          if (out.matches.length >= out.maxResults) return;
        }
      }
    }
  }
}

function toolSearch(ctx, args) {
  if (typeof args.query !== 'string' || args.query === '') throw new ToolError('E_ARGS_INVALID', 'query 必须为非空字符串');
  const root = resolveWorkspace(ctx.config, ctx.workspace);
  const relPath = args.path !== undefined ? String(args.path) : '.';
  const { abs } = validatePath(ctx.config, ctx.workspace, relPath, false);
  const st = fs.statSync(abs);
  const baseDir = st.isDirectory() ? abs : path.dirname(abs);
  const baseRel = st.isDirectory() ? (relPath === '.' ? '' : relPath.replace(/\\/g, '/')) : path.dirname(relPath).replace(/\\/g, '/');

  const maxResults = Math.min(Math.max(1, Number(args.maxResults) || 50), 200);
  let matcher;
  if (args.regex) {
    let re;
    try {
      re = new RegExp(args.query, args.caseSensitive ? '' : 'i');
    } catch (e) {
      throw new ToolError('E_ARGS_INVALID', '非法正则：' + e.message);
    }
    matcher = (line) => re.test(line);
  } else {
    const needle = args.caseSensitive ? args.query : args.query.toLowerCase();
    matcher = (line) => (args.caseSensitive ? line.includes(needle) : line.toLowerCase().includes(needle));
  }
  const out = { matches: [], maxResults, filesScanned: 0 };
  if (st.isFile()) {
    // 单文件搜索
    const buf = fs.readFileSync(abs);
    if (!sniffBinary(buf)) {
      buf.toString('utf8').split('\n').forEach((line, i) => {
        if (out.matches.length < maxResults && matcher(line)) {
          out.matches.push({ file: baseRel ? `${baseRel}/${path.basename(abs)}` : path.basename(abs), line: i + 1, text: line.slice(0, 240) });
        }
      });
      out.filesScanned = 1;
    }
  } else {
    searchWalk(baseDir, baseRel, matcher, out);
  }
  return { matches: out.matches, truncated: out.matches.length >= maxResults, filesScanned: out.filesScanned };
}

function runCaptured(cmd, cmdArgs, cwd, timeoutMs, maxOut, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, {
      cwd,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1' },
      ...(opts && opts.shell ? { shell: true } : {}),
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    const cap = (buf, chunk) => {
      if (buf.length >= maxOut) {
        truncated = true;
        return buf;
      }
      const merged = Buffer.concat([buf, chunk]);
      if (merged.length > maxOut) {
        truncated = true;
        return merged.slice(0, maxOut);
      }
      return merged;
    };
    child.stdout.on('data', (c) => (stdout = cap(stdout, c)));
    child.stderr.on('data', (c) => (stderr = cap(stderr, c)));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      } catch {}
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout: '', stderr: String(err.message), exitCode: -1, truncated: false, timedOut: false, spawnError: true });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        exitCode: code === null ? -1 : code,
        truncated,
        timedOut,
      });
    });
  });
}

async function toolBash(ctx, args) {
  const verdict = checkBashCommand(args.command);
  if (verdict.verdict === 'blocked') throw new ToolError('E_BASH_BLOCKED', verdict.reason);
  if (verdict.verdict === 'confirm' && !ctx.confirmed) {
    throw new ToolError('E_NEEDS_CONFIRM', verdict.reason);
  }
  const root = resolveWorkspace(ctx.config, ctx.workspace);
  const timeoutMs = Math.min(Math.max(1000, Number(args.timeoutMs) || ctx.config.bashTimeoutMs), ctx.config.bashTimeoutMaxMs);
  // shell:true 以支持 dir/type 等 cmd 内建；命令已过元字符封禁
  const r = await runCaptured(args.command.trim(), [], root, timeoutMs, BASH_OUT_MAX, { shell: true });
  if (r.timedOut) throw new ToolError('E_TIMEOUT', `命令超时（${timeoutMs}ms）已终止。stdout 已捕获部分：${r.stdout.slice(0, 500)}`);
  return {
    stdout: r.stdout,
    stderr: r.stderr.slice(0, 8192),
    exitCode: r.exitCode,
    truncated: r.truncated,
  };
}

function toolGitStatus(ctx, args) {
  const { abs, posixRel } = validatePath(ctx.config, ctx.workspace, args.path !== undefined ? String(args.path) : '.', false);
  const dir = fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
  const r = spawnSync('git', ['-C', dir, 'status', '--porcelain=v1', '-b'], {
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 15000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  if (r.error || r.status !== 0) {
    throw new ToolError('E_INTERNAL', `git 不可用或目录不是 git 仓库：${posixRel} :: ${(r.stderr || String(r.error)).slice(0, 300)}`);
  }
  const lines = String(r.stdout).split('\n').filter(Boolean);
  let branch = '';
  let ahead = null;
  let behind = null;
  const entries = [];
  for (const line of lines) {
    if (line.startsWith('## ')) {
      const m = line.match(/^##\s+([^.\s]+(?:\.[^.]+)?)(?:\s+\.\.\.)?.*?\[?(?:ahead (\d+))?,?\s*(?:behind (\d+))?\]?\s*$/);
      branch = (line.match(/^##\s+(\S+)/) || [])[1] || '';
      ahead = (line.match(/ahead (\d+)/) || [])[1] || null;
      behind = (line.match(/behind (\d+)/) || [])[1] || null;
    } else {
      entries.push(line);
    }
  }
  return { branch, ahead: ahead ? Number(ahead) : 0, behind: behind ? Number(behind) : 0, entries };
}

async function toolGitDiff(ctx, args) {
  const { abs, posixRel } = validatePath(ctx.config, ctx.workspace, args.path !== undefined ? String(args.path) : '.', false);
  const dir = fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
  const gitArgs = ['-C', dir, 'diff', '--no-color'];
  if (args.staged) gitArgs.push('--staged');
  if (args.path !== undefined && fs.statSync(abs).isFile()) gitArgs.push('--', posixRel);
  const maxBytes = Math.min(Math.max(1024, Number(args.maxBytes) || DIFF_MAX_BYTES_DEFAULT), 256 * 1024);
  const r = await runCaptured('git', gitArgs, dir, 30000, maxBytes + 1);
  if (r.exitCode !== 0) throw new ToolError('E_INTERNAL', `git diff 失败：${r.stderr.slice(0, 300)}`);
  let diff = r.stdout;
  let truncated = false;
  let fullDiffFile = null;
  if (Buffer.byteLength(diff, 'utf8') > maxBytes) {
    truncated = true;
    const outsDir = path.join(dir, '.dsh-pro', 'outputs');
    fs.mkdirSync(outsDir, { recursive: true });
    const name = `diff-${Date.now()}.patch`;
    fs.writeFileSync(path.join(outsDir, name), diff, 'utf8');
    fullDiffFile = `.dsh-pro/outputs/${name}`;
    diff = Buffer.from(diff, 'utf8').slice(0, maxBytes).toString('utf8');
  }
  return { diff, truncated, fullDiffFile, empty: diff.trim() === '' };
}

// dsh_handoff 的实际逻辑在 handoff.js（异步任务模型）
function toolHandoff(ctx, args, handoff) {
  if (typeof args.planText !== 'string' || args.planText.trim() === '') {
    throw new ToolError('E_ARGS_INVALID', 'planText 必须为非空字符串（完整计划内容）');
  }
  const workspace = resolveWorkspace(ctx.config, ctx.workspace);
  return handoff.start({
    config: ctx.config,
    workspace,
    planText: args.planText,
    taskNote: typeof args.taskNote === 'string' ? args.taskNote : '',
    timeoutMs: args.timeoutMs !== undefined ? Number(args.timeoutMs) : undefined,
  });
}

// 读执行日志尾部（CodexPro execution-log.jsonl 模式的轻量版）
function toolLog(ctx, args) {
  const root = resolveWorkspace(ctx.config, ctx.workspace);
  const abs = path.join(root, LOG_REL_PATH);
  if (!fs.existsSync(abs)) return { log: '(尚无执行日志)', lines: 0, file: LOG_REL_PATH };
  const n = Math.min(Math.max(1, Number(args.lines) || 100), 1000);
  const text = fs.readFileSync(abs, 'utf8');
  const all = text.split('\n').filter(Boolean);
  const tail = all.slice(-n);
  return { log: tail.join('\n'), lines: tail.length, totalEvents: all.length, file: LOG_REL_PATH };
}

// ---------------------------------------------------------------------------
// 执行日志：每次工具调用追加一条 JSONL 到 <workspace>/.dsh-pro/logs/execution-log.jsonl
// 参照 CodexPro：追加式、只增不改，供用户回溯"模型到底对我的电脑做了什么"。
// ---------------------------------------------------------------------------
const LOG_OMIT_KEYS = new Set(['content', 'newText', 'oldText', 'planText']);

function summarizeArgs(args) {
  const out = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (LOG_OMIT_KEYS.has(k)) { out[k] = `<省略 ${String(v).length} 字符>`; continue; }
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    out[k] = s.length > 160 ? s.slice(0, 160) + `…(${s.length}字符)` : s;
  }
  return out;
}

function logExecution(ctx, name, args, result, error, durationMs) {
  try {
    const root = resolveWorkspace(ctx.config, ctx.workspace);
    const dir = path.dirname(path.join(root, LOG_REL_PATH));
    fs.mkdirSync(dir, { recursive: true });
    const event = {
      ts: new Date().toISOString(),
      tool: name,
      args: summarizeArgs(args),
      ok: !error,
      durationMs,
      workspace: ctx.workspace,
    };
    if (error) event.error = { code: error.code || 'E_INTERNAL', message: String(error.message).slice(0, 300) };
    if (result && typeof result === 'object' && result.runId) event.runId = result.runId;
    fs.appendFileSync(path.join(root, LOG_REL_PATH), JSON.stringify(event) + '\n', 'utf8');
  } catch {
    // 日志失败绝不影响主流程
  }
}

/** 统一入口。返回 {ok:true,data} 或抛 ToolError。每次调用自动写执行日志。 */
async function runTool(name, args, ctx, handoff) {
  args = args && typeof args === 'object' ? args : {};
  const t0 = Date.now();
  try {
    let data;
    switch (name) {
      case 'dsh_tree': data = toolTree(ctx, args); break;
      case 'dsh_read': data = toolRead(ctx, args); break;
      case 'dsh_write': data = toolWrite(ctx, args); break;
      case 'dsh_edit': data = toolEdit(ctx, args); break;
      case 'dsh_search': data = toolSearch(ctx, args); break;
      case 'dsh_bash': data = await toolBash(ctx, args); break;
      case 'dsh_git_status': data = toolGitStatus(ctx, args); break;
      case 'dsh_git_diff': data = await toolGitDiff(ctx, args); break;
      case 'dsh_handoff': data = toolHandoff(ctx, args, handoff); break;
      case 'dsh_log': data = toolLog(ctx, args); break;
      default:
        throw new ToolError('E_TOOL_NOT_FOUND', `未知工具：${name}`);
    }
    logExecution(ctx, name, args, data, null, Date.now() - t0);
    // 每个成功结果都带上日志路径，模型/用户随时可 dsh_read 或 dsh_log 查看
    if (data && typeof data === 'object' && !data.logFile) data.logFile = LOG_REL_PATH;
    return data;
  } catch (e) {
    logExecution(ctx, name, args, null, e, Date.now() - t0);
    throw e;
  }
}

module.exports = { TOOL_DEFS, runTool, checkBashCommand, runCaptured, BASH_BLACKLIST_RE };
