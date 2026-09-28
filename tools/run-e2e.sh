#!/usr/bin/env bash
# tools/run-e2e.sh — 一条命令跑完整端到端测试
#
# 为什么要包一层：微信开发者工具的自动化服务是「一次性」的 ——
# 客户端一断开，IDE 立刻回收端口。所以「起服务」和「跑脚本」必须连着做。
#
# 另外端口不能落在 Windows 保留段里（Hyper-V/WSL 会占用 9366-9465 等），
# 且 --auto-port 只在「新建」窗口时生效，所以必须先 close。
#   netsh int ipv4 show excludedportrange protocol=tcp   # 查保留段
#
# 用法：sh tools/run-e2e.sh [端口]
#
# 注意：**不要用 `bash tools/run-e2e.sh`**。本机 `bash` 解析到
# C:/Windows/system32/bash（即 WSL），会被安全策略拦截；而 `sh` 指向
# Git Bash 自带的 /c/Program Files/Git/usr/bin/sh，可正常执行。
# 用 `sh` 调用，或在 Git Bash 里直接逐条执行下面这些命令。

set -u
PORT="${1:-9700}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PROJECT="$(cd "$HERE/.." && pwd)"
CLI_DIR="${WX_CLI_DIR:-D:/迅雷下载/微信web开发者工具}"
NODE_BIN="${NODE_BIN:-C:/Users/share/.workbuddy/binaries/node/versions/22.22.2-3/node.exe}"
NODE_MODULES="${NODE_MODULES:-C:/Users/share/.workbuddy/binaries/node/workspace/node_modules}"

if [ ! -f "$CLI_DIR/cli.bat" ]; then
  echo "找不到 cli.bat，请设置 WX_CLI_DIR 环境变量指向微信开发者工具安装目录" >&2
  exit 1
fi

echo "== 1/2 关闭项目窗口并开启自动化（端口 $PORT）=="
(cd "$CLI_DIR" && ./cli.bat close --project "$PROJECT" >/dev/null 2>&1)
sleep 2
(cd "$CLI_DIR" && ./cli.bat auto --project "$PROJECT" --auto-port "$PORT" 2>&1 | tail -3)

echo "== 等待窗口就绪 =="
# 端口 LISTENING 不等于自动化 WS 已就绪。实测 10-12s 会握手超时
# （timeout waiting for automator response），必须等满 30s。
sleep 30
if ! netstat -ano | grep LISTENING | grep -q ":$PORT "; then
  echo "端口 $PORT 没有监听 —— 该端口可能落在 Windows 保留段里，换一个再试" >&2
  exit 1
fi

echo "== 2/2 运行端到端测试 =="
NODE_PATH="$NODE_MODULES" "$NODE_BIN" "$HERE/e2e-test.cjs" "$PORT"
