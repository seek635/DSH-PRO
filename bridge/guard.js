'use strict';
// DSH PRO - guard.js
// 安全核心：workspace 白名单、路径规范化、.. 逃逸拒绝、符号链接逃逸拒绝、敏感文件名单。
// 校验链：resolve -> 拒绝 .. / 绝对路径 -> realpath 前缀必须落在 allowedRoots -> 写操作逐段 lstat 拒符号链接 -> 敏感名单。

const fs = require('fs');
const path = require('path');

/** 工具层统一错误。server.js 据此映射 HTTP 状态码。 */
class ToolError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.extra = extra || null;
  }
}

/** 高敏文件：读写一律拒绝（密钥/凭据类）。posixRel 匹配。 */
const SENSITIVE_KEY_PATTERNS = [
  /\.pem$/i,
  /\.key$/i,
  /id_rsa/i,
  /id_ed25519/i,
  /credential/i,
  /\.pfx$/i,
  /\.p12$/i,
  /secrets?\.(json|ya?ml|txt)$/i,
];

/** .env 类：读拒绝；写降级为需要用户确认。 */
const ENV_PATTERNS = [/(^|\/)\.env(\..*)?$/i];

/** 写操作需用户确认（E_NEEDS_CONFIRM）的文件。 */
const CONFIRM_WRITE_PATTERNS = [
  ...ENV_PATTERNS,
  /(^|\/)package\.json$/i,
  /package-lock\.json$/i,
  /pnpm-lock\.yaml$/i,
  /yarn\.lock$/i,
];

/** 禁止写入的目录段。 */
const DENY_WRITE_DIR_SEGMENTS = ['.git', 'node_modules'];

/** 二进制判定：按扩展名 + 空字节嗅探。 */
const BINARY_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'zip', 'gz', 'tar', '7z', 'rar',
  'exe', 'dll', 'so', 'dylib', 'pdf', 'mp3', 'mp4', 'avi', 'mov', 'wav', 'flac',
  'wasm', 'woff', 'woff2', 'ttf', 'eot', 'otf', 'bin', 'db', 'sqlite', 'sqlite3',
  'node', 'pyc', 'class', 'jar', 'iso', 'msi',
]);

function looksBinaryByExt(p) {
  const ext = path.extname(p).replace('.', '').toLowerCase();
  return BINARY_EXTS.has(ext);
}

function sniffBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  // UTF-8 BOM 合法；其余含 BOM 的 UTF-16 文件按二进制处理
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) return true;
  return false;
}

function loadConfig(bridgeDir) {
  const cfgPath = path.join(bridgeDir, 'config.json');
  let raw = fs.readFileSync(cfgPath, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // 去除 PowerShell 写出的 BOM
  const cfg = JSON.parse(raw);
  if (!Array.isArray(cfg.allowedRoots) || cfg.allowedRoots.length === 0) {
    throw new Error('config.json: allowedRoots 不能为空');
  }
  cfg.allowedRoots = cfg.allowedRoots.map((r) => path.resolve(String(r)));
  cfg.port = Number(cfg.port) || 8765;
  cfg.bashTimeoutMs = Number(cfg.bashTimeoutMs) || 20000;
  cfg.bashTimeoutMaxMs = Number(cfg.bashTimeoutMaxMs) || 120000;
  cfg.handoffTimeoutMs = Number(cfg.handoffTimeoutMs) || 300000;
  cfg.handoffTimeoutMaxMs = Number(cfg.handoffTimeoutMaxMs) || 1800000;
  cfg.dailySendLimit = Number(cfg.dailySendLimit) || 200;
  return cfg;
}

/** 解析 workspace 参数：必须是 allowedRoots 之一（缺省取第一个）。返回规范化的绝对路径。 */
function resolveWorkspace(config, ws) {
  const roots = config.allowedRoots;
  if (ws === undefined || ws === null || String(ws).trim() === '') return roots[0];
  const target = path.resolve(String(ws));
  const hit = roots.find((r) => r.toLowerCase() === target.toLowerCase());
  if (!hit) {
    throw new ToolError(
      'E_ROOT_NOT_ALLOWED',
      `workspace "${ws}" 不在 allowedRoots 白名单中。可用：${roots.join(' ; ')}`
    );
  }
  return hit;
}

/**
 * 校验 workspace 内相对路径，返回 { abs, root, posixRel, needConfirm }。
 * forWrite=true 时启用写侧全部限制。
 */
function validatePath(config, workspace, relPath, forWrite) {
  if (typeof relPath !== 'string' || relPath.trim() === '') {
    throw new ToolError('E_ARGS_INVALID', 'path 必须为非空字符串（工作区相对路径）');
  }
  if (relPath.length > 1024) {
    throw new ToolError('E_ARGS_INVALID', 'path 过长');
  }
  // 拒绝绝对路径与 UNC
  if (/^[a-zA-Z]:[\\/]/.test(relPath) || relPath.startsWith('\\\\') || relPath.startsWith('/')) {
    throw new ToolError('E_PATH_ESCAPE', '只允许工作区相对路径，不允许绝对路径');
  }
  const root = resolveWorkspace(config, workspace);
  const abs = path.resolve(root, relPath);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ToolError('E_PATH_ESCAPE', `路径越出工作区根：${relPath}`);
  }
  const posixRel = rel.split(path.sep).join('/');
  const segs = rel.split(path.sep);

  if (forWrite && segs.some((s) => DENY_WRITE_DIR_SEGMENTS.includes(s.toLowerCase()))) {
    throw new ToolError('E_FORBIDDEN_PATH', `禁止写 ${DENY_WRITE_DIR_SEGMENTS.join(' / ')} 目录`);
  }

  const keyHit = SENSITIVE_KEY_PATTERNS.some((re) => re.test(posixRel));
  if (keyHit) {
    throw new ToolError('E_FORBIDDEN_PATH', '敏感文件（密钥/凭据类）禁止访问');
  }
  const envHit = ENV_PATTERNS.some((re) => re.test(posixRel));
  if (!forWrite && envHit) {
    throw new ToolError('E_FORBIDDEN_PATH', '.env 类文件禁止读取');
  }
  const needConfirm = Boolean(forWrite && CONFIRM_WRITE_PATTERNS.some((re) => re.test(posixRel)));

  // 符号链接逃逸防护：
  // 1) 找到最深"存在"的祖先并 realpath，必须落在 realpath(root) 内；
  let ancestor = abs;
  while (true) {
    try {
      fs.realpathSync.native(ancestor);
      break;
    } catch {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        throw new ToolError('E_PATH_ESCAPE', `无法解析路径：${relPath}`);
      }
      ancestor = parent;
    }
  }
  let realRoot;
  try {
    realRoot = fs.realpathSync.native(root);
  } catch {
    throw new ToolError('E_ROOT_NOT_ALLOWED', `workspace 不存在或不可访问：${root}`);
  }
  let realAncestor;
  try {
    realAncestor = fs.realpathSync.native(ancestor);
  } catch {
    throw new ToolError('E_SYMLINK_ESCAPE', '路径存在无法解析的链接');
  }
  if (realAncestor !== realRoot && !realAncestor.startsWith(realRoot + path.sep)) {
    throw new ToolError('E_SYMLINK_ESCAPE', '符号链接逃逸：解析后路径越出工作区');
  }
  // 2) 写操作：从 root 到 abs 逐段 lstat，任何已存在的符号链接段都拒绝（防悬空链接写穿）。
  if (forWrite) {
    const sub = path.relative(root, abs);
    if (sub) {
      let cur = root;
      const parts = sub.split(path.sep);
      for (const part of parts) {
        cur = path.join(cur, part);
        try {
          const st = fs.lstatSync(cur);
          if (st.isSymbolicLink()) {
            throw new ToolError('E_SYMLINK_ESCAPE', `路径中含有符号链接，禁止写穿：${posixRel}`);
          }
        } catch (err) {
          if (err instanceof ToolError) throw err;
          // 段尚不存在：后续段由 mkdir 创建，安全
          break;
        }
      }
    }
    // 3) 目标本身若已存在且是符号链接，拒绝覆盖
    try {
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) {
        throw new ToolError('E_SYMLINK_ESCAPE', `目标本身是符号链接，禁止覆盖：${posixRel}`);
      }
    } catch (err) {
      if (err instanceof ToolError) throw err;
      // 不存在 -> 将创建
    }
  } else {
    // 读：目标存在则 realpath 必须仍在 root 内（防"root 内链接指向外部"）
    let realAbs = null;
    try {
      realAbs = fs.realpathSync.native(abs);
    } catch {
      /* 不存在，交由上层报 ENOENT */
    }
    if (realAbs && realAbs !== realRoot && !realAbs.startsWith(realRoot + path.sep)) {
      throw new ToolError('E_SYMLINK_ESCAPE', '符号链接逃逸：解析后路径越出工作区');
    }
  }

  return { abs, root, posixRel, needConfirm };
}

/** 确保路径字符串打码（审计日志用）：64 位 hex、sk- 开头的串。 */
function redact(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/\b[0-9a-f]{64}\b/gi, '<token64>')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '<sk>')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer <redacted>');
}

module.exports = {
  ToolError,
  loadConfig,
  resolveWorkspace,
  validatePath,
  looksBinaryByExt,
  sniffBinary,
  redact,
};
