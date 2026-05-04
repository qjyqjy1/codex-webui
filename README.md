# Codex Web UI

一个直接连接本机 `codex` CLI 的轻量 Web 界面。

## 特性

- 服务端持久化会话和请求历史
- 每个 Web 会话会映射到一个真实的 Codex thread
- 默认禁用任意 shell 执行接口
- 无第三方依赖，Node 18+ 可直接启动

## 启动

```bash
npm start
```

默认监听 `0.0.0.0:9009`。

如果你后面要把 `longxiaui.xyz` 指到别的服务，例如 `openclaw`，可以单独起一个 80 端口反代：

```bash
TARGET_PORT=3000 npm run proxy
```

上面的例子表示把 `longxiaui.xyz`、`www.longxiaui.xyz` 从 `0.0.0.0:80` 转发到 `127.0.0.1:3000`。脚本会在启动前自动放开当前命名空间的低位端口限制。

## 可用环境变量

- `PORT`: 服务端口，默认 `9009`
- `HOST`: 监听地址，默认 `0.0.0.0`
- `CODEX_BIN`: `codex` 可执行文件路径，默认 `codex`
- `CODEX_WORKDIR`: Codex 会话的工作区，默认当前仓库目录
- `CODEX_TIMEOUT_MS`: 单次 Codex 请求超时，默认 `0`（关闭），如需限制可显式设置毫秒数
- `ENABLE_EXECUTE_API`: 是否启用旧的 `/api/execute` 接口，默认关闭
- `PROXY_PORT`: 反向代理监听端口，默认 `80`
- `PROXY_HOST`: 反向代理监听地址，默认 `0.0.0.0`
- `PROXY_SERVER_NAMES`: 允许转发的 Host 列表，逗号分隔，默认 `longxiaui.xyz,www.longxiaui.xyz`
- `TARGET_HOST`: 反向代理目标地址，默认 `127.0.0.1`
- `TARGET_PORT`: 反向代理目标端口，必填，例如 `3000`

## 数据目录

运行时会在仓库下生成：

- `data/sessions/`: 会话文件
- `data/history.json`: 请求历史

## 配置说明

- 仓库根目录的 `./config.toml` 主要是这个 Web UI 的配置；其中 `[server].max_permissions`、`auto_confirm`、`no_permission_prompts`，以及 `[permissions].auto_grant`、`confirm_required` 会覆盖 Web UI 发起会话时的 Codex 运行权限。
- 如果你想显式指定运行权限，也可以在工作区 `./config.toml` 里加 `[codex]` 段，使用 `sandbox_mode`、`approval_policy`，或 `dangerously_bypass_approvals_and_sandbox = true`。
- Codex CLI 默认读取 `CODEX_HOME/config.toml`，通常是 `~/.codex/config.toml`。
- 如果看到 `[features].web_search_request is deprecated`，请修改 Codex CLI 的配置文件，删除 `[features]` 下的 `web_search_request = true`。
- 如需显式覆盖 web search，请改用顶层 `web_search = "live"`、`"cached"` 或 `"disabled"`。
