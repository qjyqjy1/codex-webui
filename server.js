const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync, spawn, exec } = require('child_process');

function parseTimeoutMs(timeoutValue) {
  const normalized = String(timeoutValue ?? '0').trim();
  const parsed = Number.parseInt(normalized, 10);

  if (!Number.isFinite(parsed)) {
    return 0;
  }

  if (parsed <= 0) {
    return 0;
  }

  return parsed;
}

const PORT = Number.parseInt(process.env.PORT || '9009', 10);
const HOST = process.env.HOST || '0.0.0.0';
const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const CODEX_WORKDIR = path.resolve(process.env.CODEX_WORKDIR || __dirname);
const CODEX_TIMEOUT_MS = parseTimeoutMs(process.env.CODEX_TIMEOUT_MS ?? '0');
const ENABLE_EXECUTE_API = process.env.ENABLE_EXECUTE_API === 'true';
const WORKSPACE_CONFIG_PATH = path.join(__dirname, 'config.toml');

const DATA_DIR = path.join(__dirname, 'data');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const RUNTIME_FILE = path.join(DATA_DIR, 'runtime.json');
const MAX_HISTORY_ITEMS = 100;
const MAX_RUN_STATUS_ENTRIES = 120;
const MAX_REQUEST_BODY_BYTES = 15 * 1024 * 1024;
const MAX_ATTACHMENTS = 6;
const MAX_TEXT_ATTACHMENT_BYTES = 512 * 1024;
const MAX_IMAGE_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const VALID_SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const VALID_APPROVAL_POLICIES = new Set(["untrusted", "on-failure", "on-request", "never"]);
const RUN_STATUSES = new Map();
const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.js', '.jsx', '.ts', '.tsx', '.json', '.yaml', '.yml',
  '.toml', '.ini', '.cfg', '.conf', '.sh', '.bash', '.zsh', '.py', '.rb', '.go',
  '.rs', '.java', '.kt', '.c', '.cc', '.cpp', '.h', '.hpp', '.css', '.scss',
  '.less', '.html', '.xml', '.sql', '.env', '.gitignore', '.dockerfile', '.log',
]);
const IMAGE_ATTACHMENT_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

ensureStorage();

function ensureStorage() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  if (!fs.existsSync(HISTORY_FILE)) {
    writeJson(HISTORY_FILE, []);
  }
  if (!fs.existsSync(RUNTIME_FILE)) {
    writeJson(RUNTIME_FILE, { configRevision: 1 });
  }
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function normalizeRuntimeState(runtimeState) {
  const configRevision = Number.isSafeInteger(runtimeState?.configRevision) && runtimeState.configRevision > 0
    ? runtimeState.configRevision
    : 1;

  return { configRevision };
}

function readRuntimeState() {
  return normalizeRuntimeState(readJson(RUNTIME_FILE, { configRevision: 1 }));
}

function writeRuntimeState(runtimeState) {
  const normalized = normalizeRuntimeState(runtimeState);
  writeJson(RUNTIME_FILE, normalized);
  return normalized;
}

function getConfigRevision() {
  return readRuntimeState().configRevision;
}

function bumpConfigRevision() {
  const nextRevision = getConfigRevision() + 1;
  return writeRuntimeState({ configRevision: nextRevision }).configRevision;
}

function sanitizeSessionId(sessionId) {
  if (!SESSION_ID_PATTERN.test(sessionId || '')) {
    throw new Error('非法会话 ID');
  }
  return sessionId;
}

function getSessionFilePath(sessionId) {
  return path.join(SESSIONS_DIR, `${sanitizeSessionId(sessionId)}.json`);
}

function normalizeSession(session) {
  const now = new Date().toISOString();
  return {
    id: sanitizeSessionId(session.id),
    title: typeof session.title === 'string' && session.title.trim() ? session.title.trim() : '新会话',
    customTitle: Boolean(session.customTitle),
    codexThreadId: typeof session.codexThreadId === 'string' && session.codexThreadId ? session.codexThreadId : null,
    configRevision: Number.isSafeInteger(session.configRevision) && session.configRevision > 0 ? session.configRevision : 0,
    createdAt: session.createdAt || now,
    updatedAt: session.updatedAt || session.createdAt || now,
    messages: Array.isArray(session.messages)
      ? session.messages
          .filter(item => item && (item.role === 'user' || item.role === 'assistant'))
          .map(item => ({
            role: item.role,
            content: typeof item.content === 'string' ? item.content : '',
            timestamp: item.timestamp || now,
          }))
      : [],
  };
}

function loadSession(sessionId) {
  const filePath = getSessionFilePath(sessionId);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return normalizeSession(readJson(filePath, null));
}

function saveSession(session) {
  const normalized = normalizeSession({
    ...session,
    updatedAt: new Date().toISOString(),
  });
  writeJson(getSessionFilePath(normalized.id), normalized);
  return normalized;
}

function createSession(title) {
  const trimmedTitle = typeof title === 'string' ? title.trim() : '';
  const now = new Date().toISOString();
  const session = {
    id: crypto.randomUUID(),
    title: trimmedTitle || '新会话',
    customTitle: Boolean(trimmedTitle),
    codexThreadId: null,
    configRevision: getConfigRevision(),
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  return saveSession(session);
}

function deleteSession(sessionId) {
  const filePath = getSessionFilePath(sessionId);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function makeSessionSummary(session) {
  const lastUserMessage = [...session.messages]
    .reverse()
    .find(item => item.role === 'user' && item.content.trim());

  return {
    id: session.id,
    title: session.title,
    customTitle: session.customTitle,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    codexThreadId: session.codexThreadId,
    messageCount: session.messages.length,
    lastMessage: lastUserMessage ? lastUserMessage.content : '',
  };
}

function listSessions() {
  return fs
    .readdirSync(SESSIONS_DIR)
    .filter(name => name.endsWith('.json'))
    .map(name => loadSession(path.basename(name, '.json')))
    .filter(Boolean)
    .sort((left, right) => new Date(right.updatedAt) - new Date(left.updatedAt))
    .map(makeSessionSummary);
}

function loadHistory() {
  return readJson(HISTORY_FILE, []);
}

function appendHistory(entry) {
  const history = loadHistory();
  history.unshift(entry);
  const trimmed = history.slice(0, MAX_HISTORY_ITEMS);
  writeJson(HISTORY_FILE, trimmed);
  return entry;
}

function truncateText(value, maxLength = 600) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}\n...`;
}

function createIdleRunStatus(sessionId) {
  return {
    sessionId,
    status: 'idle',
    mode: null,
    startedAt: null,
    endedAt: null,
    threadId: null,
    messagePreview: '',
    entries: [],
    sequence: 0,
  };
}

function cloneRunStatus(runStatus) {
  if (!runStatus) {
    return null;
  }

  return {
    sessionId: runStatus.sessionId,
    status: runStatus.status,
    mode: runStatus.mode,
    startedAt: runStatus.startedAt,
    endedAt: runStatus.endedAt,
    threadId: runStatus.threadId,
    messagePreview: runStatus.messagePreview,
    entries: runStatus.entries.map(entry => ({ ...entry })),
    sequence: runStatus.sequence || 0,
  };
}

function getRunStatus(sessionId) {
  return cloneRunStatus(RUN_STATUSES.get(sessionId)) || createIdleRunStatus(sessionId);
}

function appendRunStatusEntry(runStatus, entry) {
  if (!runStatus) {
    return null;
  }

  runStatus.sequence = (runStatus.sequence || 0) + 1;
  const nextEntry = {
    id: runStatus.sequence,
    timestamp: entry.timestamp || new Date().toISOString(),
    level: entry.level || 'info',
    category: entry.category || 'system',
    label: entry.label || '状态更新',
    detail: typeof entry.detail === 'string' ? entry.detail : '',
  };

  runStatus.entries.push(nextEntry);
  if (runStatus.entries.length > MAX_RUN_STATUS_ENTRIES) {
    runStatus.entries = runStatus.entries.slice(-MAX_RUN_STATUS_ENTRIES);
  }

  return nextEntry;
}

function emitRunStatusEntry(hooks, entry) {
  if (!entry || !hooks || typeof hooks.onStatusEntry !== 'function') {
    return;
  }

  hooks.onStatusEntry({ ...entry });
}

function createRunStatus(sessionId, options) {
  const runStatus = {
    sessionId,
    status: 'running',
    mode: options?.mode || 'fresh',
    startedAt: new Date().toISOString(),
    endedAt: null,
    threadId: options?.threadId || null,
    messagePreview: summarizePrompt(options?.message || ''),
    entries: [],
    sequence: 0,
  };

  RUN_STATUSES.set(sessionId, runStatus);
  appendRunStatusEntry(runStatus, {
    label: '消息已提交',
    detail: truncateText(options?.message || '', 240),
  });

  if (options?.mode === 'resume' && options?.threadId) {
    appendRunStatusEntry(runStatus, {
      label: '继续当前线程',
      detail: options.threadId,
    });
  } else if (options?.replayContext) {
    appendRunStatusEntry(runStatus, {
      level: 'warning',
      label: '配置已变更',
      detail: '当前会话将切到新线程继续，并自动带上最近上下文。',
    });
  } else {
    appendRunStatusEntry(runStatus, {
      label: '启动新线程',
      detail: '当前消息将按新请求直接执行。',
    });
  }

  appendRunStatusEntry(runStatus, {
    label: '等待 Codex 响应',
    detail: '已启动 Codex CLI，正在接收实时事件。',
  });

  return runStatus;
}

function finalizeRunStatus(runStatus, status, detail) {
  if (!runStatus) {
    return;
  }

  runStatus.status = status;
  runStatus.endedAt = new Date().toISOString();
  appendRunStatusEntry(runStatus, {
    level: status === 'success' ? 'success' : 'error',
    label: status === 'success' ? '本次运行完成' : '本次运行失败',
    detail: truncateText(detail || '', 800),
  });
}

function formatUsageSummary(usage) {
  if (!usage || typeof usage !== 'object') {
    return '';
  }

  const parts = [];
  if (Number.isFinite(usage.input_tokens)) {
    parts.push(`input ${usage.input_tokens}`);
  }
  if (Number.isFinite(usage.output_tokens)) {
    parts.push(`output ${usage.output_tokens}`);
  }
  if (Number.isFinite(usage.reasoning_output_tokens)) {
    parts.push(`reasoning ${usage.reasoning_output_tokens}`);
  }
  if (Number.isFinite(usage.cached_input_tokens) && usage.cached_input_tokens > 0) {
    parts.push(`cached ${usage.cached_input_tokens}`);
  }
  return parts.join(' · ');
}

function formatCommandCompletion(item) {
  const parts = [item.command || ''];
  if (Number.isFinite(item.exit_code)) {
    parts.push(`exit_code=${item.exit_code}`);
  }
  if (item.aggregated_output) {
    parts.push(truncateText(item.aggregated_output, 1200));
  }
  return parts.filter(Boolean).join('\n');
}

function handleRunItemEvent(runStatus, item, phase, hooks) {
  if (!runStatus || !item) {
    return;
  }

  if (item.type === 'command_execution') {
    const entry = appendRunStatusEntry(runStatus, {
      level: phase === 'completed' && item.exit_code && item.exit_code !== 0 ? 'error' : phase === 'completed' ? 'success' : 'info',
      category: 'command',
      label: phase === 'started' ? '执行命令' : '命令完成',
      detail: phase === 'started' ? item.command || '' : formatCommandCompletion(item),
    });
    emitRunStatusEntry(hooks, entry);
    return;
  }

  if (item.type === 'agent_message' && typeof item.text === 'string' && item.text.trim()) {
    const text = item.text.trim();
    const entry = appendRunStatusEntry(runStatus, {
      level: 'info',
      category: 'message',
      label: phase === 'started' ? 'Codex 输出中' : 'Codex 消息',
      detail: truncateText(text, 1200),
    });
    emitRunStatusEntry(hooks, entry);
    if (hooks && typeof hooks.onAssistantMessage === 'function') {
      hooks.onAssistantMessage(text, {
        phase,
        item: { ...item },
      });
    }
    return;
  }

  if (item.type === 'error' && typeof item.message === 'string') {
    const entry = appendRunStatusEntry(runStatus, {
      level: 'error',
      category: 'error',
      label: 'Codex 错误',
      detail: truncateText(item.message, 1200),
    });
    emitRunStatusEntry(hooks, entry);
    return;
  }

  if (phase === 'started') {
    const entry = appendRunStatusEntry(runStatus, {
      label: `开始 ${item.type || '事件'}`,
      detail: truncateText(JSON.stringify(item), 800),
    });
    emitRunStatusEntry(hooks, entry);
    return;
  }

  const entry = appendRunStatusEntry(runStatus, {
    level: 'success',
    label: `${item.type || '事件'} 完成`,
    detail: truncateText(JSON.stringify(item), 800),
  });
  emitRunStatusEntry(hooks, entry);
}

function handleRunEventLine(runStatus, line, hooks) {
  const trimmed = String(line || '').trim();
  if (!trimmed || !trimmed.startsWith('{')) {
    return;
  }

  let event;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
    runStatus.threadId = event.thread_id;
    const entry = appendRunStatusEntry(runStatus, {
      label: '线程已启动',
      detail: event.thread_id,
    });
    emitRunStatusEntry(hooks, entry);
    return;
  }

  if (event.type === 'turn.started') {
    const entry = appendRunStatusEntry(runStatus, {
      label: '开始处理本轮请求',
      detail: 'Codex 已开始执行当前任务。',
    });
    emitRunStatusEntry(hooks, entry);
    return;
  }

  if (event.type === 'turn.completed') {
    const entry = appendRunStatusEntry(runStatus, {
      level: 'success',
      label: '本轮处理完成',
      detail: formatUsageSummary(event.usage),
    });
    emitRunStatusEntry(hooks, entry);
    return;
  }

  if ((event.type === 'item.started' || event.type === 'item.completed') && event.item) {
    handleRunItemEvent(runStatus, event.item, event.type === 'item.started' ? 'started' : 'completed', hooks);
  }
}

function handleRunDiagnosticLine(runStatus, line, hooks) {
  const trimmed = String(line || '').trim();
  if (!trimmed) {
    return;
  }

  if (trimmed.includes('[features].web_search_request is deprecated')) {
    return;
  }

  if (trimmed === 'Reading additional input from stdin...') {
    return;
  }

  const entry = appendRunStatusEntry(runStatus, {
    level: 'warning',
    category: 'diagnostic',
    label: '运行诊断',
    detail: truncateText(trimmed, 1200),
  });
  emitRunStatusEntry(hooks, entry);
}

function selectSessionContextMessages(session, maxMessages = 24, maxChars = 12000) {
  const sourceMessages = Array.isArray(session?.messages) ? session.messages : [];
  const selected = [];
  let charCount = 0;

  for (let index = sourceMessages.length - 1; index >= 0; index -= 1) {
    const item = sourceMessages[index];
    if (!item || (item.role !== 'user' && item.role !== 'assistant')) {
      continue;
    }

    const content = typeof item.content === 'string' ? item.content.trim() : '';
    if (!content) {
      continue;
    }

    const nextSize = charCount + content.length;
    if (selected.length >= maxMessages || (selected.length > 0 && nextSize > maxChars)) {
      break;
    }

    selected.push({
      role: item.role,
      content,
    });
    charCount = nextSize;
  }

  return selected.reverse();
}

function buildSessionReplayPrompt(session) {
  const messages = selectSessionContextMessages(session);
  if (!messages.length) {
    return '';
  }

  if (messages.length === 1 && messages[0].role === 'user') {
    return messages[0].content;
  }

  const transcript = messages
    .map(item => `${item.role === 'user' ? '用户' : '助手'}：${item.content}`)
    .join('\n\n');

  return [
    '你正在继续一个已有会话。',
    '由于模型或接口配置已经更新，旧线程不再复用。',
    '下面是这个会话最近的上下文，请保持连续性，并直接回应最后一条用户消息。',
    '',
    transcript,
  ].join('\n');
}

function summarizePrompt(prompt) {
  return (prompt || '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function deriveTitle(prompt) {
  const text = summarizePrompt(prompt);
  return text || '新会话';
}

function getFileExtension(fileName) {
  return path.extname(String(fileName || '')).toLowerCase();
}

function sanitizeAttachmentName(fileName) {
  const cleaned = path.basename(String(fileName || 'attachment'))
    .replace(/[^\w.\-()+\[\\] ]+/g, '_')
    .trim();
  return cleaned || 'attachment';
}

function isImageAttachment(mimeType, extension) {
  return String(mimeType || '').toLowerCase().startsWith('image/') || IMAGE_ATTACHMENT_EXTENSIONS.has(extension);
}

function isTextAttachment(mimeType, extension) {
  const normalizedMime = String(mimeType || '').toLowerCase();
  return normalizedMime.startsWith('text/')
    || normalizedMime.includes('json')
    || normalizedMime.includes('xml')
    || normalizedMime.includes('yaml')
    || normalizedMime.includes('javascript')
    || normalizedMime.includes('typescript')
    || TEXT_ATTACHMENT_EXTENSIONS.has(extension);
}

function inferCodeFenceLanguage(fileName) {
  const extension = getFileExtension(fileName);
  const map = {
    '.js': 'js',
    '.jsx': 'jsx',
    '.ts': 'ts',
    '.tsx': 'tsx',
    '.json': 'json',
    '.md': 'md',
    '.py': 'python',
    '.sh': 'bash',
    '.yml': 'yaml',
    '.yaml': 'yaml',
    '.toml': 'toml',
    '.html': 'html',
    '.css': 'css',
    '.xml': 'xml',
    '.sql': 'sql',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
    '.c': 'c',
    '.cc': 'cpp',
    '.cpp': 'cpp',
    '.h': 'c',
    '.hpp': 'cpp',
  };
  return map[extension] || '';
}

function normalizeAttachmentsInput(attachmentsInput) {
  if (!attachmentsInput) {
    return [];
  }

  if (!Array.isArray(attachmentsInput)) {
    throw new Error('附件格式无效');
  }

  if (attachmentsInput.length > MAX_ATTACHMENTS) {
    throw new Error(`附件数量不能超过 ${MAX_ATTACHMENTS} 个`);
  }

  return attachmentsInput.map((item, index) => {
    const name = sanitizeAttachmentName(item?.name || `attachment-${index + 1}`);
    const mimeType = String(item?.mimeType || '').trim().toLowerCase();
    const data = String(item?.data || '').trim();

    if (!data) {
      throw new Error(`附件内容为空：${name}`);
    }

    return {
      name,
      mimeType,
      data,
    };
  });
}

function buildAttachmentPrompt(message, preparedAttachments) {
  if (!preparedAttachments || (!preparedAttachments.imageNames.length && !preparedAttachments.textBlocks.length)) {
    return message;
  }

  const sections = [message];

  if (preparedAttachments.imageNames.length) {
    sections.push([
      '本次消息附带了图片附件，请结合图片内容一起处理：',
      preparedAttachments.imageNames.map(name => `- ${name}`).join('\n'),
    ].join('\n'));
  }

  if (preparedAttachments.textBlocks.length) {
    sections.push([
      '本次消息附带了以下文本/代码附件：',
      preparedAttachments.textBlocks.join('\n\n'),
    ].join('\n'));
  }

  return sections.filter(Boolean).join('\n\n');
}

function buildStoredUserMessage(message, attachments) {
  if (!attachments || !attachments.length) {
    return message;
  }

  return [
    message,
    '',
    `[附件] ${attachments.map(item => item.name).join(', ')}`,
  ].join('\n');
}

function normalizeChatMessage(message, attachments) {
  const trimmedMessage = String(message || '').trim();
  if (trimmedMessage) {
    return trimmedMessage;
  }

  if (attachments && attachments.length) {
    return '请查看附件并处理。';
  }

  return '';
}

function prepareAttachments(attachments) {
  const normalizedAttachments = normalizeAttachmentsInput(attachments);
  const prepared = {
    imagePaths: [],
    imageNames: [],
    textBlocks: [],
    tempPaths: [],
  };

  for (const attachment of normalizedAttachments) {
    const bytes = Buffer.from(attachment.data, 'base64');
    const extension = getFileExtension(attachment.name);

    if (isImageAttachment(attachment.mimeType, extension)) {
      if (bytes.length > MAX_IMAGE_ATTACHMENT_BYTES) {
        throw new Error(`图片附件过大：${attachment.name}`);
      }

      const safeExtension = extension || '.png';
      const tempFilePath = path.join(UPLOADS_DIR, `${crypto.randomUUID()}${safeExtension}`);
      fs.writeFileSync(tempFilePath, bytes);
      prepared.imagePaths.push(tempFilePath);
      prepared.imageNames.push(attachment.name);
      prepared.tempPaths.push(tempFilePath);
      continue;
    }

    if (!isTextAttachment(attachment.mimeType, extension)) {
      throw new Error(`暂不支持该附件类型：${attachment.name}`);
    }

    if (bytes.length > MAX_TEXT_ATTACHMENT_BYTES) {
      throw new Error(`文本附件过大：${attachment.name}`);
    }

    const content = bytes.toString('utf8');
    const language = inferCodeFenceLanguage(attachment.name);
    prepared.textBlocks.push([
      `[附件] ${attachment.name}`,
      `\`\`\`${language}`,
      content,
      '```',
    ].join('\n'));
  }

  return prepared;
}

function cleanupPreparedAttachments(preparedAttachments) {
  for (const tempPath of preparedAttachments?.tempPaths || []) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Ignore cleanup failures for temporary upload files.
    }
  }
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_REQUEST_BODY_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });

    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('请求 JSON 无法解析'));
      }
    });

    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function writeNdjsonLine(res, payload) {
  res.write(`${JSON.stringify(payload)}\n`);
}

function createNdjsonStream(res, req) {
  let closed = false;

  const markClosed = () => {
    closed = true;
  };

  req.on('aborted', markClosed);
  req.on('close', markClosed);
  res.on('close', markClosed);
  res.on('finish', markClosed);

  return {
    write(payload) {
      if (closed || res.destroyed || res.writableEnded) {
        return false;
      }

      try {
        writeNdjsonLine(res, payload);
        return true;
      } catch {
        closed = true;
        return false;
      }
    },
    isClosed() {
      return closed || res.destroyed || res.writableEnded;
    },
  };
}

function getLanAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const values of Object.values(interfaces)) {
    for (const entry of values || []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        addresses.push(entry.address);
      }
    }
  }

  return [...new Set(addresses)];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
}

function matchScalar(tomlContent, key) {
  const escapedKey = escapeRegExp(key);
  const match = tomlContent.match(new RegExp(`^${escapedKey}\\s*=\\s*"?([^"\\n]+)"?`, 'm'));
  return match ? match[1].trim() : null;
}

function matchProviderName(tomlContent, providerKey) {
  if (!providerKey) {
    return null;
  }

  const escapedKey = escapeRegExp(providerKey);
  const sectionMatch = tomlContent.match(
    new RegExp(`\\[model_providers\\.${escapedKey}\\]([\\s\\S]*?)(?=\\n\\[|$)`, 'm')
  );

  if (!sectionMatch) {
    return providerKey;
  }

  return matchScalar(sectionMatch[1], 'name') || providerKey;
}

function matchBoolean(tomlContent, key) {
  const escapedKey = escapeRegExp(key);
  const match = tomlContent.match(new RegExp(`^${escapedKey}\s*=\s*(true|false)\s*$`, 'mi'));
  if (!match) {
    return null;
  }
  return match[1].toLowerCase() === "true";
}

function getTomlSectionContent(tomlContent, sectionName) {
  const escapedSectionName = escapeRegExp(sectionName);
  const sectionMatch = tomlContent.match(
    new RegExp(`\\[${escapedSectionName}\\]([\s\S]*?)(?=\n\\[|$)`)
  );

  return sectionMatch ? sectionMatch[1] : '';
}

function matchSectionScalar(tomlContent, sectionName, key) {
  const sectionContent = getTomlSectionContent(tomlContent, sectionName);
  return sectionContent ? matchScalar(sectionContent, key) : null;
}

function matchSectionBoolean(tomlContent, sectionName, key) {
  const sectionContent = getTomlSectionContent(tomlContent, sectionName);
  return sectionContent ? matchBoolean(sectionContent, key) : null;
}

function normalizeSandboxModeValue(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return VALID_SANDBOX_MODES.has(normalized) ? normalized : null;
}

function normalizeApprovalPolicyValue(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return VALID_APPROVAL_POLICIES.has(normalized) ? normalized : null;
}

function describeRuntimePermissions(runtimePermissions) {
  if (!runtimePermissions) {
    return '跟随 Codex CLI 配置';
  }

  if (runtimePermissions.dangerouslyBypass) {
    return 'danger-full-access · 无需审批';
  }

  const approvalLabels = {
    untrusted: '仅信任命令免审批',
    'on-failure': '失败后审批',
    'on-request': '按需审批',
    never: '无需审批',
  };
  const parts = [];

  if (runtimePermissions.sandboxMode) {
    parts.push(runtimePermissions.sandboxMode);
  }
  if (runtimePermissions.approvalPolicy) {
    parts.push(approvalLabels[runtimePermissions.approvalPolicy] || runtimePermissions.approvalPolicy);
  }

  return parts.length ? parts.join(' · ') : '跟随 Codex CLI 配置';
}

function readWorkspaceRuntimePermissions() {
  if (!fs.existsSync(WORKSPACE_CONFIG_PATH)) {
    return {
      path: null,
      sandboxMode: null,
      approvalPolicy: null,
      dangerouslyBypass: false,
      usesWorkspaceOverrides: false,
      summary: '跟随 Codex CLI 配置',
    };
  }

  const content = fs.readFileSync(WORKSPACE_CONFIG_PATH, 'utf8');
  const maxPermissions = matchSectionBoolean(content, 'server', 'max_permissions') === true;
  const autoConfirm = matchSectionBoolean(content, 'server', 'auto_confirm') === true;
  const noPermissionPrompts = matchSectionBoolean(content, 'server', 'no_permission_prompts') === true;
  const autoGrant = matchSectionBoolean(content, 'permissions', 'auto_grant') === true;
  const confirmRequired = matchSectionBoolean(content, 'permissions', 'confirm_required');

  const explicitSandboxMode = normalizeSandboxModeValue(
    matchSectionScalar(content, 'codex', 'sandbox_mode')
    || matchSectionScalar(content, 'codex', 'sandbox')
    || matchSectionScalar(content, 'permissions', 'sandbox_mode')
    || matchSectionScalar(content, 'permissions', 'sandbox')
  );
  const explicitApprovalPolicy = normalizeApprovalPolicyValue(
    matchSectionScalar(content, 'codex', 'approval_policy')
    || matchSectionScalar(content, 'codex', 'ask_for_approval')
    || matchSectionScalar(content, 'permissions', 'approval_policy')
    || matchSectionScalar(content, 'permissions', 'ask_for_approval')
  );

  let sandboxMode = explicitSandboxMode;
  if (!sandboxMode && maxPermissions) {
    sandboxMode = 'danger-full-access';
  }

  const autoApproveRequested = autoConfirm || noPermissionPrompts || autoGrant || confirmRequired === false;
  let approvalPolicy = explicitApprovalPolicy;
  if (!approvalPolicy && autoApproveRequested) {
    approvalPolicy = 'never';
  }

  const requestedDangerouslyBypass = matchSectionBoolean(
    content,
    'codex',
    'dangerously_bypass_approvals_and_sandbox'
  ) === true;
  const dangerouslyBypass = requestedDangerouslyBypass
    || (maxPermissions && sandboxMode === 'danger-full-access' && approvalPolicy === 'never');

  const runtimePermissions = {
    path: WORKSPACE_CONFIG_PATH,
    sandboxMode: dangerouslyBypass ? 'danger-full-access' : sandboxMode,
    approvalPolicy: dangerouslyBypass ? 'never' : approvalPolicy,
    dangerouslyBypass,
    usesWorkspaceOverrides: Boolean(
      maxPermissions
      || autoApproveRequested
      || requestedDangerouslyBypass
      || explicitSandboxMode
      || explicitApprovalPolicy
    ),
  };

  runtimePermissions.summary = describeRuntimePermissions(runtimePermissions);
  return runtimePermissions;
}

function buildRuntimePermissionArgs(runtimePermissions) {
  if (!runtimePermissions) {
    return [];
  }

  if (runtimePermissions.dangerouslyBypass) {
    return ['--dangerously-bypass-approvals-and-sandbox'];
  }

  const args = [];
  if (runtimePermissions.sandboxMode) {
    args.push('-c', `sandbox_mode="${escapeTomlString(runtimePermissions.sandboxMode)}"`);
  }
  if (runtimePermissions.approvalPolicy) {
    args.push('-c', `approval_policy="${escapeTomlString(runtimePermissions.approvalPolicy)}"`);
  }
  return args;
}
function parseProviders(tomlContent, currentProviderKey) {
  const providers = [];
  const sectionPattern = /^\[model_providers\.([^\]]+)\]\s*$/gm;
  let match;

  while ((match = sectionPattern.exec(tomlContent)) !== null) {
    const key = match[1].trim().replace(/^"(.*)"$/, '$1');
    const sectionStart = match.index + match[0].length;
    const nextHeaderOffset = tomlContent.slice(sectionStart).search(/\n\[/);
    const sectionEnd = nextHeaderOffset === -1 ? tomlContent.length : sectionStart + nextHeaderOffset + 1;
    const sectionContent = tomlContent.slice(sectionStart, sectionEnd);
    const name = matchScalar(sectionContent, 'name') || key;
    const baseUrl = matchScalar(sectionContent, 'base_url');

    providers.push({
      key,
      name,
      displayName: deriveProviderDisplayName(baseUrl, name),
      baseUrl,
      wireApi: matchScalar(sectionContent, 'wire_api'),
      requiresOpenaiAuth: matchBoolean(sectionContent, 'requires_openai_auth'),
      isCurrent: key === currentProviderKey,
    });
  }

  return providers;
}

function findSectionKeyLine(tomlContent, sectionName, key) {
  const keyPattern = new RegExp(`^${key.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*=`);
  const lines = tomlContent.split(/\r?\n/);
  let currentSection = null;

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);

    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      continue;
    }

    if (currentSection === sectionName && keyPattern.test(trimmed)) {
      return index + 1;
    }
  }

  return null;
}

function buildConfigWarnings(tomlContent, configPath) {
  const warnings = [];
  const deprecatedWebSearchLine = findSectionKeyLine(tomlContent, 'features', 'web_search_request');

  if (deprecatedWebSearchLine) {
    warnings.push({
      code: 'deprecated.features.web_search_request',
      level: 'warning',
      path: configPath,
      line: deprecatedWebSearchLine,
      message: '检测到已弃用的 `[features].web_search_request` 配置，Codex 新版本默认已启用 web search。',
      fix: '删除 `[features]` 下的 `web_search_request = true`；如需显式覆盖，请改用顶层 `web_search = "live"`、`"cached"` 或 `"disabled"`。',
    });
  }

  return warnings;
}

function isValidProviderKey(key) {
  return /^[A-Za-z0-9_-]+$/.test(key);
}

function parseUrlSafely(value) {
  try {
    return new URL(String(value || ''));
  } catch {
    return null;
  }
}

function slugifyProviderKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function deriveProviderDisplayName(baseUrl, fallback) {
  const parsedUrl = parseUrlSafely(baseUrl);
  if (!parsedUrl) {
    return String(fallback || baseUrl || 'provider');
  }

  const host = parsedUrl.host.replace(/^www\./, '') || String(fallback || 'provider');
  const normalizedPath = parsedUrl.pathname.replace(/\/+$/g, '');

  if (!normalizedPath || normalizedPath === '/' || /^\/v\d+$/i.test(normalizedPath)) {
    return host;
  }

  return `${host}${normalizedPath}`;
}

function deriveProviderKey(baseUrl, fallback) {
  const parsedUrl = parseUrlSafely(baseUrl);
  if (!parsedUrl) {
    return slugifyProviderKey(fallback) || 'provider';
  }

  const host = parsedUrl.host.replace(/^www\./, '');
  const pathSegments = parsedUrl.pathname
    .split('/')
    .map(item => item.trim())
    .filter(Boolean)
    .filter(item => !/^v\d+$/i.test(item));
  const candidate = slugifyProviderKey([host, ...pathSegments].join('-'));
  return candidate || slugifyProviderKey(fallback) || 'provider';
}

function ensureUniqueProviderKey(candidateKey, providers, originalKey) {
  const baseKey = candidateKey || 'provider';
  const existingKeys = new Set((providers || []).map(item => item.key));

  if (!existingKeys.has(baseKey) || baseKey === originalKey) {
    return baseKey;
  }

  let suffix = 2;
  while (existingKeys.has(`${baseKey}-${suffix}`) && `${baseKey}-${suffix}` !== originalKey) {
    suffix += 1;
  }

  return `${baseKey}-${suffix}`;
}

function escapeTomlString(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function normalizeProviderInput(providerInput, providers, originalKey, existingProvider) {
  const baseUrl = String(providerInput?.baseUrl || '').trim();
  const requestedKey = String(providerInput?.key || '').trim();
  const requestedName = String(providerInput?.name || '').trim();
  const wireApi = String(providerInput?.wireApi || existingProvider?.wireApi || '').trim() || 'responses';
  const requiresOpenaiAuth = providerInput?.requiresOpenaiAuth == null
    ? existingProvider?.requiresOpenaiAuth !== false
    : Boolean(providerInput.requiresOpenaiAuth);

  if (requestedKey && !isValidProviderKey(requestedKey)) {
    throw new Error('内部接口标识格式无效');
  }
  if (!baseUrl) {
    throw new Error('Base URL 不能为空');
  }

  const derivedFallback = deriveProviderDisplayName(baseUrl, 'provider');
  const key = ensureUniqueProviderKey(
    requestedKey || originalKey || deriveProviderKey(baseUrl, derivedFallback),
    providers,
    originalKey
  );
  const name = requestedName || deriveProviderDisplayName(baseUrl, key);

  return {
    key,
    name,
    displayName: deriveProviderDisplayName(baseUrl, name),
    baseUrl,
    wireApi,
    requiresOpenaiAuth,
  };
}

function buildProviderSection(provider) {
  return [
    `[model_providers.${provider.key}]`,
    `name = "${escapeTomlString(provider.name)}"`,
    `base_url = "${escapeTomlString(provider.baseUrl)}"`,
    `wire_api = "${escapeTomlString(provider.wireApi)}"`,
    `requires_openai_auth = ${provider.requiresOpenaiAuth ? 'true' : 'false'}`,
    '',
  ].join('\n');
}

function findProviderSection(tomlContent, providerKey) {
  const escapedKey = escapeRegExp(providerKey);
  const sectionPattern = new RegExp(`^\\[model_providers\\.${escapedKey}\\]\\s*$`, 'm');
  const sectionMatch = sectionPattern.exec(tomlContent);

  if (!sectionMatch) {
    return null;
  }

  const sectionStart = sectionMatch.index;
  const bodyStart = sectionStart + sectionMatch[0].length;
  const nextHeaderOffset = tomlContent.slice(bodyStart).search(/\n\[/);
  const sectionEnd = nextHeaderOffset === -1 ? tomlContent.length : bodyStart + nextHeaderOffset + 1;

  return {
    start: sectionStart,
    end: sectionEnd,
    text: tomlContent.slice(sectionStart, sectionEnd),
  };
}

function setModelProviderValue(tomlContent, providerKey) {
  if (!providerKey) {
    return tomlContent;
  }

  if (/^model_provider\s*=.*$/m.test(tomlContent)) {
    return tomlContent.replace(/^model_provider\s*=.*$/m, `model_provider = "${providerKey}"`);
  }

  return `model_provider = "${providerKey}"\n${tomlContent}`;
}

function hasTopLevelTomlKey(tomlContent, key) {
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);

  for (const line of tomlContent.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      return false;
    }

    if (keyPattern.test(line)) {
      return true;
    }
  }

  return false;
}

function setTopLevelTomlValue(tomlContent, key, rawValue) {
  const lines = tomlContent.split(/\r?\n/);
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  const firstSectionIndex = lines.findIndex(line => /^\s*\[/.test(line));
  const searchEnd = firstSectionIndex === -1 ? lines.length : firstSectionIndex;

  for (let index = 0; index < searchEnd; index += 1) {
    if (keyPattern.test(lines[index])) {
      lines[index] = `${key} = ${rawValue}`;
      return lines.join('\n');
    }
  }

  lines.splice(searchEnd, 0, `${key} = ${rawValue}`);
  return lines.join('\n');
}

function setTopLevelTomlStringValue(tomlContent, key, value) {
  return setTopLevelTomlValue(tomlContent, key, `"${escapeTomlString(value)}"`);
}

function removeTomlKeyLines(tomlContent, key) {
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  return tomlContent
    .split(/\r?\n/)
    .filter(line => !keyPattern.test(line))
    .join('\n');
}

function normalizeTomlSpacing(tomlContent) {
  return tomlContent.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function normalizeCodexConfigContent(tomlContent) {
  if (!/^\s*web_search_request\s*=.*$/m.test(tomlContent)) {
    return normalizeTomlSpacing(tomlContent);
  }

  const deprecatedWebSearch = matchBoolean(tomlContent, 'web_search_request');
  let nextContent = removeTomlKeyLines(tomlContent, 'web_search_request');

  if (!hasTopLevelTomlKey(nextContent, 'web_search') && deprecatedWebSearch !== null) {
    const nextValue = deprecatedWebSearch ? '"live"' : '"disabled"';
    nextContent = setTopLevelTomlValue(nextContent, 'web_search', nextValue);
  }

  return normalizeTomlSpacing(nextContent);
}

function normalizeCodexConfigFile() {
  const configPath = getCodexConfigPath();
  if (!configPath) {
    return null;
  }

  const currentContent = fs.readFileSync(configPath, 'utf8');
  const normalizedContent = normalizeCodexConfigContent(currentContent);

  if (normalizedContent !== currentContent) {
    fs.writeFileSync(configPath, normalizedContent);
  }

  return {
    configPath,
    changed: normalizedContent !== currentContent,
    content: normalizedContent,
  };
}

function upsertProviderConfig(options) {
  const originalKey = String(options?.originalKey || '').trim() || null;
  const setAsCurrent = Boolean(options?.setAsCurrent);
  const hasModelInput = Boolean(options && Object.prototype.hasOwnProperty.call(options, 'model'));
  const nextModel = String(options?.model || '').trim();
  const nextOpenAiApiKey = String(options?.openAiApiKey || '').trim();

  const configPath = getCodexConfigPath();
  if (!configPath) {
    throw new Error('未找到 Codex 配置文件');
  }

  let content = normalizeCodexConfigFile()?.content || fs.readFileSync(configPath, 'utf8');
  const currentProviderKey = matchScalar(content, 'model_provider');
  const providers = parseProviders(content);
  const existingProvider = originalKey ? providers.find(item => item.key === originalKey) : null;
  const provider = normalizeProviderInput(options?.provider, providers, originalKey, existingProvider);

  if (originalKey && !existingProvider) {
    throw new Error(`未找到接口: ${originalKey}`);
  }

  if (providers.some(item => item.key === provider.key && item.key !== originalKey)) {
    throw new Error(`内部接口标识冲突: ${provider.key}`);
  }

  const nextSection = buildProviderSection(provider);
  const existingSection = originalKey ? findProviderSection(content, originalKey) : null;

  if (existingSection) {
    const before = content.slice(0, existingSection.start).replace(/\n+$/, '\n\n');
    const after = content.slice(existingSection.end).replace(/^\n+/, '\n\n');
    content = `${before}${nextSection}${after}`.trimEnd() + '\n';
  } else {
    content = `${content.trimEnd()}\n\n${nextSection}`;
  }

  let nextCurrentProviderKey = currentProviderKey;
  if (!nextCurrentProviderKey) {
    nextCurrentProviderKey = provider.key;
  }
  if (originalKey && currentProviderKey === originalKey && provider.key !== originalKey) {
    nextCurrentProviderKey = provider.key;
  }
  if (setAsCurrent) {
    nextCurrentProviderKey = provider.key;
  }

  content = setModelProviderValue(content, nextCurrentProviderKey);
  if (hasModelInput) {
    if (!nextModel) {
      throw new Error('模型名称不能为空');
    }
    content = setTopLevelTomlStringValue(content, 'model', nextModel);
  }
  fs.writeFileSync(configPath, content);

  if (nextOpenAiApiKey) {
    updateOpenAiApiKey(nextOpenAiApiKey);
  }

  const config = readCodexConfigSummary();
  const savedProvider = config.providers.find(item => item.key === provider.key) || null;

  return {
    config,
    provider: savedProvider,
    auth: readCodexAuthSummary(),
  };
}

function getCodexConfigPath() {
  const configCandidates = [
    path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml'),
    path.join(os.homedir(), '.config', 'codex', 'config.toml'),
  ];

  return configCandidates.find(candidate => fs.existsSync(candidate)) || null;
}

function getCodexAuthPath() {
  const authCandidates = [
    path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json'),
    path.join(os.homedir(), '.config', 'codex', 'auth.json'),
  ];

  return authCandidates.find(candidate => fs.existsSync(candidate)) || authCandidates[0];
}

function readCodexAuthSummary() {
  const authPath = getCodexAuthPath();
  const auth = readJson(authPath, {});
  const openAiApiKey = typeof auth.OPENAI_API_KEY === 'string' ? auth.OPENAI_API_KEY.trim() : '';

  return {
    authPath,
    hasOpenAiApiKey: Boolean(openAiApiKey),
  };
}

function updateOpenAiApiKey(openAiApiKey) {
  const nextApiKey = String(openAiApiKey || '').trim();
  if (!nextApiKey) {
    return readCodexAuthSummary();
  }

  const authPath = getCodexAuthPath();
  const auth = readJson(authPath, {});
  auth.OPENAI_API_KEY = nextApiKey;
  writeJson(authPath, auth);
  return readCodexAuthSummary();
}

function readCodexConfigSummary() {
  const normalized = normalizeCodexConfigFile();
  const configPath = normalized?.configPath || getCodexConfigPath();

  if (configPath) {
    const content = normalized?.content || fs.readFileSync(configPath, 'utf8');
    const providerKey = matchScalar(content, 'model_provider');
    const providers = parseProviders(content, providerKey);

    return {
      configPath,
      model: matchScalar(content, 'model'),
      reasoningEffort: matchScalar(content, 'model_reasoning_effort'),
      contextWindow: matchScalar(content, 'model_context_window'),
      modelProvider: providerKey,
      providerName: providers.find(item => item.key === providerKey)?.displayName || matchProviderName(content, providerKey),
      providers,
      configWarnings: buildConfigWarnings(content, configPath),
    };
  }

  return {
    configPath: null,
    model: null,
    reasoningEffort: null,
    contextWindow: null,
    modelProvider: null,
    providerName: null,
    providers: [],
    configWarnings: [],
  };
}

function updateModelProvider(providerKey) {
  const normalizedProviderKey = String(providerKey || '').trim();
  if (!normalizedProviderKey) {
    throw new Error('接口不能为空');
  }

  const configPath = getCodexConfigPath();
  if (!configPath) {
    throw new Error('未找到 Codex 配置文件');
  }

  let content = normalizeCodexConfigFile()?.content || fs.readFileSync(configPath, 'utf8');
  const providers = parseProviders(content);
  if (!providers.some(provider => provider.key === normalizedProviderKey)) {
    throw new Error(`未找到接口: ${normalizedProviderKey}`);
  }

  if (/^model_provider\s*=.*$/m.test(content)) {
    content = content.replace(/^model_provider\s*=.*$/m, `model_provider = "${normalizedProviderKey}"`);
  } else {
    content = `model_provider = "${normalizedProviderKey}"\n${content}`;
  }

  fs.writeFileSync(configPath, content);
  return readCodexConfigSummary();
}

function getCodexVersion() {
  try {
    return execFileSync(CODEX_BIN, ['--version'], {
      cwd: CODEX_WORKDIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'Codex CLI';
  }
}

// clean script output control chars
function cleanScriptOutput(text) {
  return text
    .replace(/\r/g, '')
    .replace(/\x1B\[[\d;?]*[A-Za-z]/g, '')
    .replace(/\x1B\][^\x07]*\x07/g, '')
    .replace(/\x1B[()[\]A-Za-z]/g, '')
    .replace(/[^\x20-\x7E\n\t\u4e00-\u9fff\u3000-\u303f\uff00-\uffef'{},:\[\]]/g, '');
}

function parseCodexJsonLines(output, initialThreadId) {
  let threadId = initialThreadId || null;
  let reply = '';
  const diagnostics = [];

  const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (!line.startsWith('{')) {
      continue;
    }

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      threadId = event.thread_id;
      continue;
    }

    if (event.type !== 'item.completed' || !event.item) {
      continue;
    }

    if (event.item.type === 'agent_message' && typeof event.item.text === 'string') {
      reply = event.item.text.trim();
      continue;
    }

    if (event.item.type === 'error' && typeof event.item.message === 'string') {
      diagnostics.push(event.item.message);
    }
  }

  return {
    threadId,
    reply,
    diagnostics,
  };
}

function filterNonFatalDiagnostics(diagnostics) {
  return diagnostics.filter(message => {
    if (!message) {
      return false;
    }

    if (message.includes('[features].web_search_request is deprecated')) {
      return false;
    }

    return true;
  });
}

function sanitizeCodexStderr(stderr) {
  return (stderr || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => {
      if (!line) {
        return false;
      }

      if (line.includes('[features].web_search_request is deprecated')) {
        return false;
      }

      if (line === 'Reading additional input from stdin...') {
        return false;
      }

      return true;
    })
    .join('\n');
}

function runCodex(message, threadId, runStatus, hooks, options = {}) {
  return new Promise((resolve, reject) => {
    normalizeCodexConfigFile();
    const runtimePermissions = readWorkspaceRuntimePermissions();
    const imageArgs = Array.isArray(options.imagePaths)
      ? options.imagePaths.flatMap(imagePath => ['--image', imagePath])
      : [];
    const permissionArgs = buildRuntimePermissionArgs(runtimePermissions);

    const args = threadId
      ? ['exec', 'resume', ...permissionArgs, '--json', '--skip-git-repo-check', ...imageArgs, '--', threadId, message]
      : ['exec', ...permissionArgs, '--json', '--skip-git-repo-check', ...imageArgs, '--', message];

    // use script PTY for codex CLI
    const shellArgs = [CODEX_BIN, ...args].map(a => {
      return "'" + String(a).replace(/'/g, "'\\''") + "'";
    }).join(' ');
    const fullCmd = `script -q -c "${shellArgs}" /dev/null`;

    let stdout = '';
    let stderr = '';
    let stdoutLineBuffer = '';
    let stderrLineBuffer = '';
    let didTimeout = false;

    const childProcess = exec(fullCmd, {
      cwd: CODEX_WORKDIR,
      env: process.env,
      maxBuffer: 50 * 1024 * 1024,
    });

    const timer = CODEX_TIMEOUT_MS > 0
      ? setTimeout(() => {
          didTimeout = true;
          childProcess.kill('SIGTERM');
          setTimeout(() => childProcess.kill('SIGKILL'), 5000);
        }, CODEX_TIMEOUT_MS)
      : null;

    childProcess.stdout.on('data', chunk => {
      const text = chunk.toString();
      stdout += text;
      stdoutLineBuffer += text;
      const lines = stdoutLineBuffer.split(/\r?\n/);
      stdoutLineBuffer = lines.pop() || '';
      for (const line of lines) {
        handleRunEventLine(runStatus, line, hooks);
      }
    });

    childProcess.stderr.on('data', chunk => {
      const text = chunk.toString();
      stderr += text;
      stderrLineBuffer += text;
      const lines = stderrLineBuffer.split(/\r?\n/);
      stderrLineBuffer = lines.pop() || '';
      for (const line of lines) {
        handleRunDiagnosticLine(runStatus, line, hooks);
      }
    });

    childProcess.on('error', error => {
      if (timer) { clearTimeout(timer); }
      reject(error);
    });

    childProcess.on('close', code => {
      if (timer) { clearTimeout(timer); }
      if (didTimeout) {
        reject(new Error(`Codex timeout (>${CODEX_TIMEOUT_MS}ms)`));
        return;
      }
      const parsed = parseCodexJsonLines(cleanScriptOutput(stdout), threadId);
      parsed.diagnostics = filterNonFatalDiagnostics(parsed.diagnostics);
      if (stdoutLineBuffer.trim()) { handleRunEventLine(runStatus, stdoutLineBuffer, hooks); }
      if (stderrLineBuffer.trim()) { handleRunDiagnosticLine(runStatus, stderrLineBuffer, hooks); }
      if (parsed.reply) { resolve(parsed); return; }
      const reparsed = parseCodexJsonLines(cleanScriptOutput(stdout), threadId);
      if (reparsed.reply) { resolve(reparsed); return; }
      const stderrText = sanitizeCodexStderr(stderr);
      if (code === 0 && !reparsed.reply && !stderrText.trim()) {
        resolve({ reply: '', threadId: threadId || '', diagnostics: [] });
        return;
      }
      const details = parsed.diagnostics.concat(stderrText).filter(Boolean).join('\n');
      reject(new Error(details || `Codex failed (exit ${code})`));
    });
  });

}

function getSafeStaticPath(requestPath) {
  const relativePath = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
  const absolutePath = path.resolve(__dirname, relativePath);
  if (!absolutePath.startsWith(__dirname + path.sep) && absolutePath !== path.join(__dirname, 'index.html')) {
    return null;
  }
  return absolutePath;
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

function buildInfoPayload() {
  const config = readCodexConfigSummary();
  const auth = readCodexAuthSummary();
  const currentProvider = config.providers.find(item => item.key === config.modelProvider);
  const runtimePermissions = readWorkspaceRuntimePermissions();
  return {
    version: getCodexVersion(),
    workdir: CODEX_WORKDIR,
    port: PORT,
    host: HOST,
    lanAddresses: getLanAddresses(),
    enableExecuteApi: ENABLE_EXECUTE_API,
    model: config.model,
    providerKey: config.modelProvider,
    providerName: currentProvider?.displayName || currentProvider?.name || config.providerName || config.modelProvider,
    reasoningEffort: config.reasoningEffort,
    contextWindow: config.contextWindow,
    configPath: config.configPath,
    workspaceConfigPath: runtimePermissions.path,
    runtimePermissions,
    configWarnings: config.configWarnings,
    providers: config.providers,
    authPath: auth.authPath,
    hasOpenAiApiKey: auth.hasOpenAiApiKey,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (req.method === 'GET' && url.pathname === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/info') {
      sendJson(res, 200, buildInfoPayload());
      return;
    }

    if (req.method === 'PATCH' && url.pathname === '/api/providers/current') {
      const body = await readRequestBody(req);
      const config = updateModelProvider(body.providerKey);
      bumpConfigRevision();
      sendJson(res, 200, {
        success: true,
        providerKey: config.modelProvider,
        providerName: config.providerName || config.modelProvider,
        providers: config.providers,
        info: buildInfoPayload(),
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/providers') {
      const body = await readRequestBody(req);
      const result = upsertProviderConfig({
        originalKey: body.originalKey,
        provider: body.provider,
        model: body.model,
        setAsCurrent: body.setAsCurrent,
        openAiApiKey: body.openAiApiKey,
      });
      bumpConfigRevision();
      sendJson(res, 200, {
        success: true,
        provider: result.provider,
        auth: result.auth,
        info: buildInfoPayload(),
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      sendJson(res, 200, listSessions());
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/sessions') {
      const body = await readRequestBody(req);
      const session = createSession(body.title);
      sendJson(res, 201, { session, sessionSummary: makeSessionSummary(session) });
      return;
    }

    const sessionStatusRouteMatch = url.pathname.match(/^\/api\/sessions\/([A-Za-z0-9_-]{1,128})\/status$/);
    if (sessionStatusRouteMatch && req.method === 'GET') {
      const sessionId = sanitizeSessionId(sessionStatusRouteMatch[1]);
      const session = loadSession(sessionId);

      if (!session) {
        sendJson(res, 404, { success: false, error: '会话不存在' });
        return;
      }

      sendJson(res, 200, { success: true, runStatus: getRunStatus(sessionId) });
      return;
    }

    const sessionRouteMatch = url.pathname.match(/^\/api\/sessions\/([A-Za-z0-9_-]{1,128})$/);
    if (sessionRouteMatch) {
      const sessionId = sanitizeSessionId(sessionRouteMatch[1]);
      const session = loadSession(sessionId);

      if (!session) {
        sendJson(res, 404, { success: false, error: '会话不存在' });
        return;
      }

      if (req.method === 'GET') {
        sendJson(res, 200, { session, sessionSummary: makeSessionSummary(session) });
        return;
      }

      if (req.method === 'PATCH') {
        const body = await readRequestBody(req);
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        if (!title) {
          sendJson(res, 400, { success: false, error: '标题不能为空' });
          return;
        }

        const updatedSession = saveSession({
          ...session,
          title,
          customTitle: true,
        });
        sendJson(res, 200, { session: updatedSession, sessionSummary: makeSessionSummary(updatedSession) });
        return;
      }

      if (req.method === 'DELETE') {
        deleteSession(sessionId);
        sendJson(res, 200, { success: true });
        return;
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/history') {
      sendJson(res, 200, loadHistory());
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/chat/stream') {
      const body = await readRequestBody(req);
      const rawMessage = typeof body.message === 'string' ? body.message : '';
      let sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
      let preparedAttachments = null;
      const attachments = normalizeAttachmentsInput(body.attachments);
      const message = normalizeChatMessage(rawMessage, attachments);

      if (!message) {
        sendJson(res, 400, { success: false, error: '消息或附件不能为空' });
        return;
      }

      let session = sessionId ? loadSession(sessionId) : null;
      if (!session) {
        session = createSession();
        sessionId = session.id;
      }

      const currentConfigRevision = getConfigRevision();
      const shouldStartFreshThread = !session.codexThreadId || session.configRevision !== currentConfigRevision;
      const startedAt = Date.now();

      session.messages.push({
        role: 'user',
        content: buildStoredUserMessage(message, attachments),
        timestamp: new Date().toISOString(),
      });

      if (!session.customTitle && session.messages.filter(item => item.role === 'user').length === 1) {
        session.title = deriveTitle(message);
      }

      session = saveSession(session);
      const shouldReplayContext = shouldStartFreshThread && session.messages.length > 1;
      const runStatus = createRunStatus(session.id, {
        message,
        threadId: shouldStartFreshThread ? null : session.codexThreadId,
        mode: shouldStartFreshThread ? 'fresh' : 'resume',
        replayContext: shouldReplayContext,
      });

      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      });
      if (res.socket && typeof res.socket.setNoDelay === 'function') {
        res.socket.setNoDelay(true);
      }
      if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
      }
      const stream = createNdjsonStream(res, req);
      const heartbeatTimer = setInterval(() => {
        stream.write({
          type: 'heartbeat',
          timestamp: new Date().toISOString(),
        });
      }, 15000);

      stream.write({
        type: 'accepted',
        session,
        sessionSummary: makeSessionSummary(session),
        runStatus: getRunStatus(session.id),
      });

      try {
        preparedAttachments = prepareAttachments(attachments);
        const basePrompt = shouldReplayContext
          ? buildSessionReplayPrompt(session)
          : message;
        const promptForCodex = buildAttachmentPrompt(basePrompt, preparedAttachments);
        const codexResult = await runCodex(
          promptForCodex,
          shouldStartFreshThread ? null : session.codexThreadId,
          runStatus,
          {
            onStatusEntry(entry) {
              stream.write({
                type: 'status_entry',
                sessionId: session.id,
                entry,
                runStatus: getRunStatus(session.id),
              });
            },
            onAssistantMessage(text, meta) {
              stream.write({
                type: 'assistant_message',
                text,
                sessionId: session.id,
                phase: meta?.phase || 'completed',
              });
            },
          },
          {
            imagePaths: preparedAttachments.imagePaths,
          }
        );

        session.codexThreadId = codexResult.threadId || session.codexThreadId;
        session.configRevision = currentConfigRevision;
        session.messages.push({
          role: 'assistant',
          content: codexResult.reply || 'Codex 没有返回内容',
          timestamp: new Date().toISOString(),
        });

        session = saveSession(session);

        const historyItem = appendHistory({
          id: crypto.randomUUID(),
          sessionId: session.id,
          prompt: message,
          promptPreview: summarizePrompt(message),
          replyPreview: summarizePrompt(codexResult.reply).slice(0, 120),
          status: 'success',
          durationMs: Date.now() - startedAt,
          timestamp: new Date().toISOString(),
        });
        finalizeRunStatus(runStatus, 'success', codexResult.reply || 'Codex 没有返回内容');

        stream.write({
          type: 'run_status',
          sessionId: session.id,
          runStatus: getRunStatus(session.id),
        });
        stream.write({
          type: 'final',
          success: true,
          response: codexResult.reply,
          session,
          sessionSummary: makeSessionSummary(session),
          historyItem,
          runStatus: getRunStatus(session.id),
        });
      } catch (error) {
        const assistantMessage = `Codex 调用失败：${error.message}`;
        finalizeRunStatus(runStatus, 'failed', error.message);
        session.messages.push({
          role: 'assistant',
          content: assistantMessage,
          timestamp: new Date().toISOString(),
        });
        session = saveSession(session);

        appendHistory({
          id: crypto.randomUUID(),
          sessionId: session.id,
          prompt: message,
          promptPreview: summarizePrompt(message),
          replyPreview: summarizePrompt(assistantMessage).slice(0, 120),
          status: 'failed',
          durationMs: Date.now() - startedAt,
          timestamp: new Date().toISOString(),
        });

        stream.write({
          type: 'run_status',
          sessionId: session.id,
          runStatus: getRunStatus(session.id),
        });
        stream.write({
          type: 'error',
          success: false,
          error: error.message,
          session,
          sessionSummary: makeSessionSummary(session),
          runStatus: getRunStatus(session.id),
        });
      } finally {
        clearInterval(heartbeatTimer);
        cleanupPreparedAttachments(preparedAttachments);
      }

      res.end();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/chat') {
      const body = await readRequestBody(req);
      const rawMessage = typeof body.message === 'string' ? body.message : '';
      let sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
      let preparedAttachments = null;
      const attachments = normalizeAttachmentsInput(body.attachments);
      const message = normalizeChatMessage(rawMessage, attachments);

      if (!message) {
        sendJson(res, 400, { success: false, error: '消息或附件不能为空' });
        return;
      }

      let session = sessionId ? loadSession(sessionId) : null;
      if (!session) {
        session = createSession();
        sessionId = session.id;
      }

      const currentConfigRevision = getConfigRevision();
      const shouldStartFreshThread = !session.codexThreadId || session.configRevision !== currentConfigRevision;

      const startedAt = Date.now();
      session.messages.push({
        role: 'user',
        content: buildStoredUserMessage(message, attachments),
        timestamp: new Date().toISOString(),
      });

      if (!session.customTitle && session.messages.filter(item => item.role === 'user').length === 1) {
        session.title = deriveTitle(message);
      }

      session = saveSession(session);
      const shouldReplayContext = shouldStartFreshThread && session.messages.length > 1;
      const runStatus = createRunStatus(session.id, {
        message,
        threadId: shouldStartFreshThread ? null : session.codexThreadId,
        mode: shouldStartFreshThread ? 'fresh' : 'resume',
        replayContext: shouldReplayContext,
      });

      try {
        preparedAttachments = prepareAttachments(attachments);
        const basePrompt = shouldReplayContext
          ? buildSessionReplayPrompt(session)
          : message;
        const promptForCodex = buildAttachmentPrompt(basePrompt, preparedAttachments);
        const codexResult = await runCodex(
          promptForCodex,
          shouldStartFreshThread ? null : session.codexThreadId,
          runStatus,
          null,
          {
            imagePaths: preparedAttachments.imagePaths,
          }
        );

        session.codexThreadId = codexResult.threadId || session.codexThreadId;
        session.configRevision = currentConfigRevision;
        session.messages.push({
          role: 'assistant',
          content: codexResult.reply || 'Codex 没有返回内容',
          timestamp: new Date().toISOString(),
        });

        session = saveSession(session);

        const historyItem = appendHistory({
          id: crypto.randomUUID(),
          sessionId: session.id,
          prompt: message,
          promptPreview: summarizePrompt(message),
          replyPreview: summarizePrompt(codexResult.reply).slice(0, 120),
          status: 'success',
          durationMs: Date.now() - startedAt,
          timestamp: new Date().toISOString(),
        });
        finalizeRunStatus(runStatus, 'success', codexResult.reply || 'Codex 没有返回内容');

        sendJson(res, 200, {
          success: true,
          response: codexResult.reply,
          session,
          sessionSummary: makeSessionSummary(session),
          historyItem,
        });
      } catch (error) {
        const assistantMessage = `Codex 调用失败：${error.message}`;
        finalizeRunStatus(runStatus, 'failed', error.message);
        session.messages.push({
          role: 'assistant',
          content: assistantMessage,
          timestamp: new Date().toISOString(),
        });
        session = saveSession(session);

        appendHistory({
          id: crypto.randomUUID(),
          sessionId: session.id,
          prompt: message,
          promptPreview: summarizePrompt(message),
          replyPreview: summarizePrompt(assistantMessage).slice(0, 120),
          status: 'failed',
          durationMs: Date.now() - startedAt,
          timestamp: new Date().toISOString(),
        });

        sendJson(res, 502, {
          success: false,
          error: error.message,
          session,
          sessionSummary: makeSessionSummary(session),
        });
      } finally {
        cleanupPreparedAttachments(preparedAttachments);
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/execute') {
      if (!ENABLE_EXECUTE_API) {
        sendJson(res, 403, {
          success: false,
          error: '已禁用 /api/execute。若确实需要，请显式设置 ENABLE_EXECUTE_API=true。',
        });
        return;
      }

      sendJson(res, 501, {
        success: false,
        error: '执行 API 已停用，请改用 Codex 会话接口。',
      });
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      sendJson(res, 404, { success: false, error: 'API 不存在' });
      return;
    }

    const filePath = getSafeStaticPath(url.pathname);
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      sendText(res, 404, '404 Not Found');
      return;
    }

    res.writeHead(200, { 'Content-Type': getMimeType(filePath) });
    res.end(fs.readFileSync(filePath));
  } catch (error) {
    const statusCode = error.message === '非法会话 ID' ? 400 : 500;
    sendJson(res, statusCode, {
      success: false,
      error: error.message || '服务器内部错误',
    });
  }
});

server.listen(PORT, HOST, () => {
  const info = buildInfoPayload();

  console.log('========================================');
  console.log('  Codex Web UI 运行中');
  console.log(`  地址: http://${HOST}:${PORT}`);
  for (const address of getLanAddresses()) {
    console.log(`  局域网: http://${address}:${PORT}`);
  }
  console.log(`  工作区: ${CODEX_WORKDIR}`);
  console.log(`  版本: ${getCodexVersion()}`);
  console.log(`  权限: ${info.runtimePermissions?.summary || '跟随 Codex CLI 配置'}`);
  if (info.configWarnings.length) {
    console.log('  配置告警:');
    for (const warning of info.configWarnings) {
      const location = warning.line ? `${warning.path}:${warning.line}` : warning.path;
      console.log(`    - ${location}`);
      console.log(`      ${warning.message}`);
      console.log(`      ${warning.fix}`);
    }
  }
  console.log('========================================');
});
