#!/bin/bash
# 학원 출석체크 서버 실행 (macOS/리눅스)
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Node.js가 설치되어 있지 않습니다."
  echo "  https://nodejs.org 에서 LTS 버전을 설치한 뒤 이 파일을 다시 실행해 주세요."
  echo ""
  read -r -p "엔터를 누르면 닫힙니다..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo ""
  echo "  프로그램 구성요소를 설치합니다. (최초 1회, 1~2분)"
  echo ""
  npm install --omit=dev || { echo "설치 실패. 인터넷 연결을 확인해 주세요."; exit 1; }
fi

echo ""
echo "  ─────────────────────────────────────────────"
echo "   출석체크 서버가 시작됩니다."
echo "   - 이 창을 닫으면 서버가 종료됩니다 (데이터는 안전하게 보관됨)"
echo "   - 출석 데이터는 data 폴더에 저장되며 컴퓨터를 꺼도 유지됩니다"
echo "  ─────────────────────────────────────────────"
echo ""
(sleep 1; open http://localhost:3000 2>/dev/null || xdg-open http://localhost:3000 2>/dev/null) &
node src/server.js
