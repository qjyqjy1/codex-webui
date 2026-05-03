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

## 可用环境变量

- `PORT`: 服务端口，默认 `9009`
- `HOST`: 监听地址，默认 `0.0.0.0`
- `CODEX_BIN`: `codex` 可执行文件路径，默认 `codex`
- `CODEX_WORKDIR`: Codex 会话的工作区，默认当前仓库目录
- `CODEX_TIMEOUT_MS`: 单次 Codex 请求超时，默认 `600000`
- `ENABLE_EXECUTE_API`: 是否启用旧的 `/api/execute` 接口，默认关闭

## 数据目录

运行时会在仓库下生成：

- `data/sessions/`: 会话文件
- `data/history.json`: 请求历史

## 配置说明

- 仓库根目录的 `./config.toml` 是这个 Web UI 自己的配置，不是 Codex CLI 主配置。
- Codex CLI 默认读取 `CODEX_HOME/config.toml`，通常是 `~/.codex/config.toml`。
- 如果看到 `[features].web_search_request is deprecated`，请修改 Codex CLI 的配置文件，删除 `[features]` 下的 `web_search_request = true`。
- 如需显式覆盖 web search，请改用顶层 `web_search = "live"`、`"cached"` 或 `"disabled"`。
