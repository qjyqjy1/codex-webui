const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const PORT = 9009;
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const HISTORY_FILE = path.join(__dirname, 'history.json');

// 确保目录存在
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, '[]');

// 获取公网IP
function getPublicIP() {
  try {
    return execSync('curl -s --max-time 5 ifconfig.me 2>/dev/null || echo ""').toString().trim();
  } catch { return ''; }
}

// 加载历史记录
function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch {
    return [];
  }
}

// 保存历史记录
function saveHistory(history) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

// 执行命令（后台模式，不等待确认）
function executeCommand(cmd, options = {}) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    let output = '';
    let status = 'success';
    let error = '';
    
    try {
      // 如果是后台执行，使用 nohup 或 & 运行
      if (options.background) {
        const backgroundCmd = `nohup sh -c '${cmd.replace(/'/g, "'\"'\"")}' > /tmp/codex_bg_${Date.now()}.log 2>&1 & echo $!`;
        execSync(backgroundCmd, { stdio: 'pipe', timeout: 5000 });
        output = '命令已在后台启动执行';
      } else {
        // 同步执行，带超时
        output = execSync(cmd, { 
          stdio: 'pipe', 
          timeout: options.timeout || 30000,
          encoding: 'utf8'
        });
      }
      output = output || '命令执行成功（无输出）';
    } catch (e) {
      status = 'failed';
      error = e.message || '执行出错';
      output = error;
    }
    
    const duration = Date.now() - startTime;
    const historyItem = {
      cmd: cmd,
      timestamp: new Date().toISOString(),
      status: status,
      duration: (duration / 1000).toFixed(1) + 's',
      output: output,
      options: options
    };
    
    const history = loadHistory();
    history.unshift(historyItem);
    if (history.length > 100) history = history.slice(0, 100);
    saveHistory(history);
    
    resolve({
      success: status === 'success',
      status: status,
      duration: duration,
      output: output,
      error: error
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);
  
  // CORS 头部
  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
  
  // OPTIONS 预检请求
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }
  
  // API: 获取系统信息
  if (url.pathname === '/api/info') {
    let config = '-- 配置文件读取失败 --';
    try {
      config = fs.readFileSync('/root/.codex/config.toml', 'utf8');
    } catch {
      try {
        config = fs.readFileSync('/root/.config/codex/config.toml', 'utf8');
      } catch {
        // 使用默认配置
        config = `model = "gpt-5.3-codex"
name = "LongCat-2.0-Preview"
model_reasoning_effort = "medium"
model_context_window = 128000
port = 9009`;
      }
    }
    res.writeHead(200, corsHeaders);
    res.end(JSON.stringify({ 
      config: config, 
      publicIP: getPublicIP(), 
      port: PORT,
      version: '2.0.0',
      permissions: 'max' // 最大权限模式
    }));
    return;
  }
  
  // API: 聊天/执行消息
  if (url.pathname === '/api/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const message = data.message || '';
        const settings = data.settings || [];
        const sessionId = data.sessionId;
        
        // 保存会话消息
        const sessionFile = path.join(SESSIONS_DIR, sessionId + '.json');
        let session = { id: sessionId, messages: [] };
        if (fs.existsSync(sessionFile)) {
          try {
            session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
          } catch {}
        }
        
        session.messages.push({
          role: 'user',
          content: message,
          timestamp: new Date().toISOString(),
          settings: settings
        });
        
        // 检查是否是命令执行
        const isCommand = message.startsWith('/') || message.startsWith('!') || message.startsWith('run:');
        let response = '';
        
        if (isCommand) {
          // 执行命令
          const cmd = message.replace(/^(\/|!|run:)/, '').trim();
          const options = {
            background: settings.includes('background'),
            stream: settings.includes('stream'),
            priority: settings.includes('priority')
          };
          
          // 最大权限：直接执行，不再请求确认
          const result = await executeCommand(cmd, options);
          
          if (result.success) {
            response = `✅ 命令执行成功\n\n📋 命令: ${cmd}\n⏱ 耗时: ${result.duration}ms\n\n📄 输出:\n${result.output ? result.output.substring(0, 2000) : '(无输出)'}`;
          } else {
            response = `❌ 命令执行失败\n\n📋 命令: ${cmd}\n⏱ 耗时: ${result.duration}ms\n\n❌ 错误: ${result.error}\n\n📄 输出:\n${result.output ? result.output.substring(0, 2000) : '(无输出)'}`;
          }
        } else {
          // AI 响应（模拟）
          const templates = {
            '项目结构': '📁 项目结构:\n\nsrc/\n├── components/\n│   ├── Button.tsx\n│   └── Input.tsx\n├── utils/\n│   └── helpers.ts\n└── App.tsx\n\npublic/\n└── index.html\n\npackage.json\nREADME.md',
            '模型': '🤖 模型信息:\n\n- 模型: gpt-5.3-codex\n- 提供商: LongCat Provider\n- 推理: Medium (中等)\n- 上下文: 128K tokens\n- 端口: 9009\n- 权限: 最大 (无需确认)',
            '重构': '🔧 代码重构建议:\n\n1. 提取重复逻辑到独立函数\n2. 使用 TypeScript 强化类型安全\n3. 拆分大型组件为更小单元\n4. 添加单元测试覆盖核心逻辑\n5. 优化性能瓶颈点',
            '测试': '🧪 测试运行结果:\n\n✅ 12 tests passed\n❌ 2 tests failed\n\n失败用例:\n- test/auth.test.ts - token过期\n- test/api.test.ts - 超时\n\n建议: 检查 token 刷新逻辑和 API 超时设置'
          };
          
          let found = false;
          for (const [key, val] of Object.entries(templates)) {
            if (message.includes(key)) {
              response = val;
              found = true;
              break;
            }
          }
          
          if (!found) {
            response = `🤖 收到您的消息: "${message}"\n\n⚡ 当前会话: ${sessionId}\n⚙️ 执行设置: ${settings.length > 0 ? settings.join(', ') : '默认'}\n\n💡 这是一个 Codex AI 助手演示界面。在生产环境中，此接口将连接到真实的 AI 模型 API 进行智能回复。`;
          }
        }
        
        session.messages.push({
          role: 'assistant',
          content: response,
          timestamp: new Date().toISOString()
        });
        
        fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
        
        res.writeHead(200, corsHeaders);
        res.end(JSON.stringify({
          success: true,
          response: response,
          sessionId: sessionId
        }));
      } catch (e) {
        res.writeHead(500, corsHeaders);
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }
  
  // API: 获取会话列表
  if (url.pathname === '/api/sessions' && req.method === 'GET') {
    try {
      const files = fs.readdirSync(SESSIONS_DIR);
      const sessions = files
        .filter(f => f.endsWith('.json'))
        .map(f => {
          try {
            return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
          } catch {
            return null;
          }
        })
        .filter(s => s !== null);
      res.writeHead(200, corsHeaders);
      res.end(JSON.stringify(sessions));
    } catch (e) {
      res.writeHead(200, corsHeaders);
      res.end(JSON.stringify([]));
    }
    return;
  }
  
  // API: 获取运行记录
  if (url.pathname === '/api/history' && req.method === 'GET') {
    try {
      const history = loadHistory();
      res.writeHead(200, corsHeaders);
      res.end(JSON.stringify(history));
    } catch (e) {
      res.writeHead(200, corsHeaders);
      res.end(JSON.stringify([]));
    }
    return;
  }
  
  // API: 执行命令
  if (url.pathname === '/api/execute' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { command, background = false, priority = false } = JSON.parse(body);
        const options = { background, priority, stream: true };
        const result = await executeCommand(command, options);
        res.writeHead(200, corsHeaders);
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, corsHeaders);
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }
  
  // 服务静态文件
  let filePath = path.join(__dirname, url.pathname === '/' ? 'index.html' : url.pathname);
  
  if (fs.existsSync(filePath)) {
    const ext = path.extname(filePath);
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon'
    };
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain; charset=utf-8' });
    res.end(fs.readFileSync(filePath));
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`========================================`);
  console.log(`  Codex Web UI 运行中`);
  console.log(`  地址: http://0.0.0.0:${PORT}`);
  console.log(`  API 接口: /api/*`);
  console.log(`  权限模式: 最大权限 (无需确认)`);
  const pub = getPublicIP();
  if (pub) console.log(`  公网地址: http://${pub}:${PORT}`);
  console.log(`========================================`);
});
