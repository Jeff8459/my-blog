#!/bin/zsh
set -e
cd "$(dirname "$0")"

# Astro 7 需要 Node >= 22.23.4。优先使用本机 Homebrew Node 24（若存在）。
if [[ -x /opt/homebrew/opt/node@24/bin/node ]]; then
  export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
fi

export PUBLISHER_OPEN=1
npm run publisher
