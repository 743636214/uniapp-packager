#!/bin/zsh
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd -- "$(dirname -- "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo '请先安装 Node.js 22 或更新版本：https://nodejs.org/'
  read -r '?按回车关闭'
  exit 1
fi
node ./scripts/launch.mjs
