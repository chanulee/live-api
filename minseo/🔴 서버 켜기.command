#!/bin/bash
# 🔴 서버 켜기.command
#
# 더블클릭하면 로컬 서버를 켜고 브라우저를 연다.
# index.html 을 그냥 더블클릭하면 file:// 로 열려서 마이크와 AudioWorklet 이 안 된다.
# 끄려면 이 터미널 창에서 Control + C 를 누르거나 창을 닫는다.

# 이 스크립트는 minseo/ 안에 있고, 서버는 그 위(저장소 루트)에서 띄워야
# http://localhost:8000/minseo/ 경로가 맞는다.
cd "$(dirname "$0")/.." || exit 1

PORT=8000
URL="http://localhost:$PORT/minseo/"

# 이미 켜져 있으면 두 번 띄우지 않고 브라우저만 연다
if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo ""
  echo "  이미 $PORT 번 포트에서 서버가 돌고 있습니다."
  echo "  브라우저만 엽니다: $URL"
  echo ""
  echo "  (이 창은 닫아도 됩니다)"
  echo ""
  open "$URL"
  exit 0
fi

echo ""
echo "  ────────────────────────────────────────"
echo "   minseo · Gemini Live Voice Agent"
echo "  ────────────────────────────────────────"
echo ""
echo "   폴더 : $(pwd)"
echo "   주소 : $URL"
echo ""
echo "   끄기 : Control + C  또는 이 창 닫기"
echo ""
echo "  ────────────────────────────────────────"
echo ""

# 서버가 뜬 다음에 브라우저를 연다
( sleep 1; open "$URL" ) &

python3 -m http.server "$PORT"
