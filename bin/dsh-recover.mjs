#!/usr/bin/env node
/**
 * dsh-recover — 诊断 DeepSeek Harness 的会话存储与工作区注册。
 *
 * 不猜、不修数据：先把你机器上真实的状态读出来，逐条对照 DSH 自己那套
 * 布局与身份规则，最后只给出「能解释问题的结论 + 一条可执行的动作」。
 *
 * 它解决的问题（都来自真实事故）：
 *   - 项目目录下出现扁平 *.jsonl（导出、解码、手工备份的常见产物）→
 *     `workspace` 插件抛 "unsupported flat-file layout"，workspaceRegistry
 *     起不来，于是 workspace/create、session/control 全部 unavailable；
 *   - 会话文件被移走/删掉后 workspace.json 里的 sessionIds 还留着 →
 *     侧边栏的会话点开就报错，或干脆消失；
 *   - 恢复了会话文件却没被任何工作区认领 → 重启后只在「未分组」里；
 *   - zstd 日志是「一帧一条记录」的多帧流，按普通单帧解压只能拿到第一行，
 *     看着像文件损坏。
 *
 * 用法：
 *   dsh-recover [--home <dir>] [--json] [--fix] [--quiet]
 *
 *   --fix  只做一件事：把项目目录下的扁平会话文件移到 <sessions>/.quarantine/
 *          <时间戳>/（移动，不删除），并打印还需要手工做的步骤。
 *
 * 退出码：0 = 干净，1 = 有问题，2 = 无法诊断（找不到目录等）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

const VERSION = '0.1.0';
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const SESSION_LOG = /^session\.v(\d+)\.jsonl(\.zstd)?$/;
const FLAT_ARTIFACT = /\.jsonl(\.zstd)?$/;

// ── 参数 ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { home: undefined, json: false, fix: false, fixOrphans: false, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--fix') out.fix = true;
    else if (arg === '--fix-orphans') out.fixOrphans = true;
    else if (arg === '--quiet') out.quiet = true;
    else if (arg === '--home') out.home = argv[++i];
    else if (arg.startsWith('--home=')) out.home = arg.slice('--home='.length);
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--version' || arg === '-v') out.version = true;
    else {
      process.stderr.write(`dsh-recover: 未知参数 ${arg}\n`);
      process.exit(2);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(`dsh-recover ${VERSION}

用法：dsh-recover [--home <dir>] [--json] [--fix] [--fix-orphans] [--quiet]

  --home <dir>     DSH 家目录，默认 $DSH_HOME 或 ~/.dsh
  --json           输出机器可读的报告
  --fix            把项目目录下的扁平会话文件移到 <DSH_HOME>/dsh-recover-quarantine/（不删除）
  --fix-orphans    把「没有被任何工作区认领」的会话挂回 cwd 相符的工作区
                   （先备份 workspace.json；**请先退出 DSH 再跑**，否则会被内存状态覆盖）
  --quiet          只输出结论与问题
`);
  process.exit(0);
}
if (args.version) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

// ── 定位 ────────────────────────────────────────────────────────────────────
function dshHome() {
  if (args.home) return path.resolve(args.home);
  if (process.env.DSH_HOME) return path.resolve(process.env.DSH_HOME);
  return path.join(os.homedir(), '.dsh');
}

function crashLogDir() {
  if (args.home) return undefined;
  const base =
    process.platform === 'win32'
      ? process.env.APPDATA
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return base ? path.join(base, '@deepseek-ai', 'dsh-desktop', 'logs') : undefined;
}

// ── zstd：多帧拼接的会话日志 ────────────────────────────────────────────────
/**
 * DSH 每次追加写一个独立 zstd 帧；单帧解压器只给你第一行，看起来像截断。
 * @returns {{ frames: number, failed: number, texts: string[] }}
 */
function decodeFrames(buffer) {
  const offsets = [];
  for (let at = buffer.indexOf(ZSTD_MAGIC); at !== -1; at = buffer.indexOf(ZSTD_MAGIC, at + 4)) offsets.push(at);
  if (offsets.length === 0) return { frames: 0, failed: 1, texts: [] };
  const texts = [];
  let failed = 0;
  for (let i = 0; i < offsets.length; i += 1) {
    const start = offsets[i];
    const end = i + 1 < offsets.length ? offsets[i + 1] : buffer.length;
    try {
      texts.push(zlib.zstdDecompressSync(buffer.subarray(start, end)).toString('utf8'));
    } catch {
      failed += 1;
    }
  }
  return { frames: offsets.length, failed, texts };
}

const utf8 = new TextDecoder('utf-8', { fatal: false });
function readUtf8(file) {
  return utf8.decode(fs.readFileSync(file));
}

/** 路径比较：Windows 大小写不敏感，其它平台严格比较。 */
function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// ── 单项检查 ────────────────────────────────────────────────────────────────
function listDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function listFiles(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** 读投影缓存里的标题，纯粹为了报告里好看。 */
function cachedTitle(home, sessionId) {
  try {
    const file = path.join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`);
    const doc = JSON.parse(readUtf8(file));
    const title = doc?.record?.rows?.title?.val;
    return typeof title === 'string' && title.trim() ? title.trim() : undefined;
  } catch {
    return undefined;
  }
}

function inspectSession(home, projectDir, sessionDir) {
  const abs = path.join(projectDir, sessionDir);
  const result = {
    id: sessionDir,
    dir: abs,
    log: undefined,
    bytes: 0,
    frames: 0,
    failedFrames: 0,
    lines: 0,
    seqMin: undefined,
    seqMax: undefined,
    torn: 0,
    badJson: 0,
    header: undefined,
    events: {},
    errors: [],
    warnings: [],
    title: undefined,
  };

  const names = listFiles(abs).filter((name) => SESSION_LOG.test(name));
  if (names.length === 0) {
    result.errors.push('目录里没有 session.vN.jsonl(.zstd)，DSH 会当作空会话');
    return result;
  }
  names.sort((a, b) => Number(SESSION_LOG.exec(b)[1]) - Number(SESSION_LOG.exec(a)[1]));
  const logName = names[0];
  const version = Number(SESSION_LOG.exec(logName)[1]);
  if (version !== 4) result.warnings.push(`日志是 v${version}，当前 DSH 只写 v4，可能需要迁移`);
  result.log = path.join(abs, logName);

  const raw = fs.readFileSync(result.log);
  result.bytes = raw.length;
  if (!logName.endsWith('.zstd')) {
    return result;
  }

  const { frames, failed, texts } = decodeFrames(raw);
  result.frames = frames;
  result.failedFrames = failed;
  if (failed > 0) result.errors.push(`${failed}/${frames} 个 zstd 帧解压失败，日志已损坏`);

  const seqs = [];
  for (let i = 0; i < texts.length; i += 1) {
    const text = texts[i];
    const complete = i < texts.length - 1;
    if (complete && !text.endsWith('\n')) result.torn += 1;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      result.lines += 1;
      try {
        const event = JSON.parse(line);
        if (typeof event.seq === 'number') seqs.push(event.seq);
        if (typeof event.type === 'string') result.events[event.type] = (result.events[event.type] ?? 0) + 1;
        if (event.type === 'session' && result.header === undefined) result.header = event;
      } catch {
        result.badJson += 1;
      }
    }
  }
  if (result.torn > 0) result.errors.push(`${result.torn} 个完整帧里含有被切断的记录（写入中途崩溃？）`);
  if (result.badJson > 0) result.errors.push(`${result.badJson} 行不是合法 JSON`);

  if (seqs.length > 0) {
    result.seqMin = Math.min(...seqs);
    result.seqMax = Math.max(...seqs);
    for (let i = 1; i < seqs.length; i += 1) {
      if (seqs[i] < seqs[i - 1]) {
        result.warnings.push('seq 不单调递增，事件顺序可疑');
        break;
      }
    }
  }

  if (result.header === undefined) {
    result.errors.push('第一行不是 session 头，DSH 无法据此定位会话');
    return result;
  }
  if (result.header.id !== sessionDir) {
    result.errors.push(`头里的 id (${result.header.id}) 与目录名 (${sessionDir}) 不一致，DSH 会拒绝加载`);
  }
  result.title = cachedTitle(home, result.header.id);
  return result;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
const home = dshHome();
const sessionsRoot = path.join(home, 'sessions');
const workspaceFile = path.join(home, 'storages', 'workspace.json');

const report = {
  tool: `dsh-recover ${VERSION}`,
  home,
  sessionsRoot,
  exists: fs.existsSync(sessionsRoot),
  projects: [],
  sessions: [],
  flatArtifacts: [],
  workspace: { path: workspaceFile, exists: false, workspaces: [], errors: [], warnings: [], orphans: [] },
  crash: { dir: crashLogDir(), files: [], findings: [] },
  errors: [],
  warnings: [],
  fixes: [],
};

if (!report.exists) {
  report.errors.push(`找不到会话目录：${sessionsRoot}`);
}

for (const project of listDirs(sessionsRoot)) {
  const projectDir = path.join(sessionsRoot, project);
  const files = listFiles(projectDir);
  const flat = files.filter((name) => FLAT_ARTIFACT.test(name));
  for (const name of flat) {
    const entry = { path: path.join(projectDir, name), project, bytes: 0 };
    try {
      entry.bytes = fs.statSync(entry.path).size;
    } catch {
      /* 竞态：文件刚好被移走 */
    }
    report.flatArtifacts.push(entry);
  }

  const sessions = [];
  for (const sessionDir of listDirs(projectDir)) {
    const inspected = inspectSession(home, projectDir, sessionDir);
    sessions.push(inspected);
    report.sessions.push({ project, ...inspected });
  }
  report.projects.push({ name: project, dir: projectDir, flat, sessions });
}

// 同一个项目目录里出现不同 cwd 的会话 → 目录名与 cwd 编码对不上
for (const project of report.projects) {
  const cwds = new Set(project.sessions.map((s) => s.header?.cwd).filter(Boolean));
  if (cwds.size > 1) {
    report.warnings.push(
      `项目目录 ${project.name} 里混着 ${cwds.size} 个不同的 cwd，DSH 的路径身份校验会拒绝其中一部分：${[...cwds].join(' | ')}`,
    );
  }
}

// 工作区注册
if (fs.existsSync(workspaceFile)) {
  report.workspace.exists = true;
  try {
    const doc = JSON.parse(readUtf8(workspaceFile));
    const table = doc?.tables?.workspaces ?? {};
    const seen = new Map();
    for (const [workspaceId, record] of Object.entries(table)) {
      const entry = {
        workspaceId,
        path: record?.path,
        title: record?.title,
        sessionIds: Array.isArray(record?.sessionIds) ? record.sessionIds : [],
      };
      report.workspace.workspaces.push(entry);
      for (const id of entry.sessionIds) {
        if (seen.has(id)) {
          report.workspace.errors.push(`会话 ${id} 同时被 ${seen.get(id)} 和 ${workspaceId} 认领，DSH 启动会校验失败`);
        } else {
          seen.set(id, workspaceId);
        }
      }
      if (typeof entry.path === 'string' && !fs.existsSync(entry.path)) {
        report.workspace.warnings.push(`工作区目录不存在：${entry.path}`);
      }
    }
    for (const session of report.sessions) {
      if (session.header === undefined) continue;
      if (!seen.has(session.header.id)) {
        report.workspace.orphans.push({ id: session.header.id, title: session.title, project: session.project });
      }
    }
    for (const [id, workspaceId] of seen) {
      if (!report.sessions.some((s) => s.header?.id === id)) {
        report.workspace.warnings.push(
          `工作区 ${workspaceId} 认领着不存在的会话 ${id}（文件被移走或删了），侧边栏会点不开`,
        );
      }
    }
  } catch (error) {
    report.workspace.errors.push(`workspace.json 无法解析：${error.message}`);
  }
} else {
  report.workspace.warnings.push('没有 storages/workspace.json，DSH 会在首次启动时重建');
}

// 崩溃日志：把常见事故和已知根因对上
if (report.crash.dir && fs.existsSync(report.crash.dir)) {
  const logs = fs
    .readdirSync(report.crash.dir)
    .filter((name) => /^crash-.*\.log$/.test(name))
    .map((name) => ({ name, file: path.join(report.crash.dir, name), at: fs.statSync(path.join(report.crash.dir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
    .slice(0, 5);
  const patterns = [
    [/unsupported flat-file layout/i, '项目目录下有扁平会话文件，workspace 服务因此起不来'],
    [/is an unspecified \(wildcard\) address/i, 'webserver 绑定了通配地址，0.2.1 直接拒绝启动'],
    [/Service "([a-zA-Z]+)" is unavailable/i, '有服务因前面的错误而 pending，相关 RPC 会全部报 unavailable'],
    [/but this backend is configured for compression/i, '会话文件与当前压缩模式不匹配（zstd 与明文混用）'],
    [/torn JSONL record/i, '会话日志写到一半崩溃，最后一个帧里有切断的记录'],
  ];
  for (const log of logs) {
    report.crash.files.push({ name: log.name, at: new Date(log.at).toISOString() });
    let text = '';
    try {
      text = readUtf8(log.file);
    } catch {
      continue;
    }
    for (const [regex, explanation] of patterns) {
      if (!regex.test(text)) continue;
      const line = text.split('\n').find((l) => regex.test(l)) ?? '';
      report.crash.findings.push({ log: log.name, explanation, evidence: line.trim().slice(0, 220) });
    }
  }
}

// 汇总结论
for (const session of report.sessions) {
  for (const error of session.errors) report.errors.push(`${session.id}: ${error}`);
  for (const warning of session.warnings) report.warnings.push(`${session.id}: ${warning}`);
}
if (report.workspace.orphans.length > 0) {
  const attachable = report.workspace.orphans.filter((orphan) => {
    const session = report.sessions.find((item) => item.header?.id === orphan.id);
    return report.workspace.workspaces.some((workspace) => samePath(workspace.path, session?.header?.cwd));
  });
  if (attachable.length > 0) {
    report.fixes.push(
      `${attachable.length} 个会话没有被任何工作区认领：退出 DSH 后跑 dsh-recover --fix-orphans 把它们挂回 cwd 相符的工作区`,
    );
  } else {
    report.fixes.push(
      '没有工作区认领的会话，其 cwd 也没有对应的工作区（例如微信桥的会话目录）：通常由插件在运行时自建，可以不管',
    );
  }
}

// --fix-orphans：把会话挂回 cwd 相符的工作区，等价于 DSH 自己的 attachSession
if (args.fixOrphans && report.workspace.orphans.length > 0) {
  const attached = [];
  const skipped = [];
  try {
    const doc = JSON.parse(readUtf8(workspaceFile));
    const table = doc?.tables?.workspaces ?? {};
    let changed = false;
    for (const orphan of report.workspace.orphans) {
      const session = report.sessions.find((item) => item.header?.id === orphan.id);
      const cwd = session?.header?.cwd;
      if (typeof cwd !== 'string') {
        skipped.push({ id: orphan.id, reason: '会话头里没有 cwd' });
        continue;
      }
      const match = Object.entries(table).find(
        ([, record]) => samePath(record?.path, cwd),
      );
      if (match === undefined) {
        skipped.push({ id: orphan.id, reason: `没有 cwd 为 ${cwd} 的工作区` });
        continue;
      }
      const [workspaceId, record] = match;
      record.sessionIds = Array.isArray(record.sessionIds) ? record.sessionIds : [];
      if (!record.sessionIds.includes(orphan.id)) {
        record.sessionIds.unshift(orphan.id);
        record.updatedAt = new Date().toISOString();
        changed = true;
      }
      attached.push({ id: orphan.id, workspaceId });
    }
    let backup;
    if (changed) {
      backup = `${workspaceFile}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      fs.copyFileSync(workspaceFile, backup);
      fs.writeFileSync(workspaceFile, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    }
    report.orphanFix = { backup, attached, skipped, changed };
    if (attached.length > 0) {
      const done = new Set(attached.map((item) => item.id));
      report.workspace.orphans = report.workspace.orphans.filter((orphan) => !done.has(orphan.id));
      report.fixes = report.fixes.filter((fix) => !fix.includes('--fix-orphans'));
    }
  } catch (error) {
    report.orphanFix = { error: error.message, attached: [], skipped };
  }
}

// --fix：只处理扁平文件，因为它是唯一能一秒钟修好、且不碰用户数据的动作
if (args.fix && report.flatArtifacts.length > 0) {
  const quarantine = path.join(home, 'dsh-recover-quarantine', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(quarantine, { recursive: true });
  for (const artifact of report.flatArtifacts) {
    const target = path.join(quarantine, path.basename(artifact.path));
    try {
      fs.renameSync(artifact.path, target);
      artifact.movedTo = target;
    } catch (error) {
      artifact.moveError = error.message;
    }
  }
}

// 隔离之后再统计：已经移走的就不再算作错误
const remainingFlat = report.flatArtifacts.filter((artifact) => artifact.movedTo === undefined);
if (remainingFlat.length > 0) {
  report.errors.push(
    `${remainingFlat.length} 个扁平会话文件位于项目目录下（DSH 会拒绝整个 session store，workspace 服务随之不可用）`,
  );
  report.fixes.push('运行 dsh-recover --fix 把它们移到隔离目录（移动，不删除）');
}

// ── 输出 ────────────────────────────────────────────────────────────────────
if (args.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.errors.length > 0 ? 1 : 0);
}

const lines = [];
const say = (text = '') => lines.push(text);
const bytes = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(0, Math.round(n / 1024))} KB`);

if (!args.quiet) {
  say(`dsh-recover ${VERSION}`);
  say(`DSH_HOME  ${home}`);
  say(`sessions  ${sessionsRoot}${report.exists ? '' : '  （不存在）'}`);
  say('');
}

if (report.sessions.length > 0 && !args.quiet) {
  say(`会话 ${report.sessions.length} 个，分属 ${report.projects.length} 个项目目录`);
  for (const session of report.sessions) {
    const state = session.errors.length > 0 ? '✗' : session.warnings.length > 0 ? '!' : '✓';
    const name = session.header?.id ?? session.id;
    const title = session.title ? `「${session.title}」` : '';
    const span = session.seqMin === undefined ? '' : `seq ${session.seqMin}–${session.seqMax}`;
    const meta = [session.frames ? `${session.frames} 帧` : '', span, bytes(session.bytes)].filter(Boolean).join(', ');
    say(`  ${state} ${name} ${title}  ${meta}`);
  }
  say('');
}

if (report.flatArtifacts.length > 0) {
  say(`✗ 扁平会话文件（会让 workspace 服务拒绝启动）：${report.flatArtifacts.length} 个`);
  for (const artifact of report.flatArtifacts) {
    const where = artifact.movedTo ? `已移到 ${artifact.movedTo}` : artifact.moveError ? `移动失败：${artifact.moveError}` : artifact.path;
    say(`    ${artifact.path}`);
    if (artifact.movedTo || artifact.moveError) say(`    → ${where}`);
  }
  say('');
}

if (report.workspace.exists && report.workspace.workspaces.length > 0) {
  say(`工作区 ${report.workspace.workspaces.length} 个，认领 ${new Set(report.workspace.workspaces.flatMap((w) => w.sessionIds)).size} 个会话`);
  for (const workspace of report.workspace.workspaces) {
    say(`  · ${workspace.title ?? '(无标题)'}  ${workspace.path}`);
  }
  if (report.workspace.orphans.length > 0) {
    say(`  ! ${report.workspace.orphans.length} 个会话没有被任何工作区认领（重启后只在「未分组」）`);
    for (const orphan of report.workspace.orphans) {
      say(`      ${orphan.id}${orphan.title ? `  「${orphan.title}」` : ''}`);
    }
  }
  say('');
}

if (report.orphanFix !== undefined) {
  const fix = report.orphanFix;
  if (fix.error !== undefined) {
    say(`! 挂回会话失败：${fix.error}`);
  } else {
    if (fix.attached.length > 0) {
      say(`已把 ${fix.attached.length} 个会话挂回工作区（备份：${fix.backup ?? '无改动'}）`);
      for (const item of fix.attached) say(`  → ${item.id} → ${item.workspaceId}`);
    }
    for (const item of fix.skipped) say(`  ! 跳过 ${item.id}：${item.reason}`);
  }
  say('');
}

if (report.crash.findings.length > 0) {
  say('崩溃日志里对上的已知问题：');
  for (const finding of report.crash.findings) {
    say(`  · ${finding.explanation}`);
    say(`    ${finding.log}: ${finding.evidence}`);
  }
  say('');
}

if (report.errors.length > 0) {
  say(`错误 ${report.errors.length} 条`);
  for (const error of report.errors) say(`  ✗ ${error}`);
  say('');
}
if (report.warnings.length > 0) {
  say(`警告 ${report.warnings.length} 条`);
  for (const warning of report.warnings) say(`  ! ${warning}`);
  say('');
}
if (report.fixes.length > 0) {
  say('可以做的事：');
  for (const fix of report.fixes) say(`  → ${fix}`);
  say('');
}

const reminders = report.warnings.length + report.workspace.orphans.length;
if (report.errors.length === 0 && reminders === 0) say('没发现问题，存储是干净的。');
else if (report.errors.length > 0) say(`有 ${report.errors.length} 个错误需要处理，另有 ${reminders} 条提醒。`);
else say(`没有错误，${reminders} 条提醒。`);

process.stdout.write(`${lines.join('\n')}\n`);
process.exit(report.errors.length > 0 ? 1 : 0);
