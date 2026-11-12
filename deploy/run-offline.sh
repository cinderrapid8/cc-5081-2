#!/usr/bin/env bash
# 无网络资源下载的复跑路径：
# 优先使用已构建的单文件产物（dist/service），无需 npm install；
# 若产物缺失且本机存在开发依赖，则本地构建一次（不下载任何运行时资源）。
# 用法：bash deploy/run-offline.sh [selftest|serve]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-selftest}"
BUNDLE="$ROOT/dist/service"
RULES_DIR="$BUNDLE/rules"
STATE_DIR="$ROOT/state"

if [[ ! -f "$BUNDLE/rule-service.mjs" ]]; then
  echo "[run-offline] 未发现单文件产物，使用本地开发依赖构建（不联网下载运行时资源）..."
  (cd "$ROOT" && node scripts/build.mjs)
fi

mkdir -p "$STATE_DIR"

if [[ "$MODE" == "selftest" ]]; then
  # 完整部署自检：干净目录、探针、客户端查询、坏候选隔离、只读目录、缺失资源、停止重启。
  exec node "$ROOT/deploy/self-check.mjs" --bundle "$BUNDLE"
fi

if [[ "$MODE" == "serve" ]]; then
  echo "[run-offline] 启动规则服务：http://${HOST:-127.0.0.1}:${PORT:-4277}"
  exec env RULES_DIR="$RULES_DIR" \
    STATE_FILE="$STATE_DIR/service.jsonl" \
    HOST="${HOST:-127.0.0.1}" \
    PORT="${PORT:-4277}" \
    node "$BUNDLE/rule-service.mjs"
fi

echo "未知模式：$MODE（支持 selftest | serve）" >&2
exit 2
