@echo off
chcp 65001 >nul
title 학원 출석체크 서버
cd /d "%~dp0"

rem 포터블 Node.js를 내려받았다면 그 경로를 우선 사용
set "PATH=%~dp0runtime\node;%PATH%"

where node >nul 2>nul
if %errorlevel%==0 goto deps
if exist "runtime\node\node.exe" goto deps

echo.
echo  Node.js가 설치되어 있지 않아 자동으로 내려받습니다. (최초 1회, 약 30MB)
echo  잠시만 기다려 주세요...
echo.
mkdir runtime 2>nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://nodejs.org/dist/v22.14.0/node-v22.14.0-win-x64.zip' -OutFile 'runtime\node.zip'"
if not exist "runtime\node.zip" (
  echo  다운로드에 실패했습니다. 인터넷 연결을 확인한 뒤 다시 실행해 주세요.
  pause
  exit /b 1
)
powershell -NoProfile -Command "Expand-Archive -Force 'runtime\node.zip' 'runtime\tmp'"
move "runtime\tmp\node-v22.14.0-win-x64" "runtime\node" >nul
rmdir /s /q "runtime\tmp" 2>nul
del "runtime\node.zip" 2>nul

:deps
if not exist "node_modules" (
  echo.
  echo  프로그램 구성요소를 설치합니다. (최초 1회, 1~2분)
  echo.
  call npm install --omit=dev
  if errorlevel 1 (
    echo  설치에 실패했습니다. 인터넷 연결을 확인한 뒤 다시 실행해 주세요.
    pause
    exit /b 1
  )
)

echo.
echo  ─────────────────────────────────────────────
echo   출석체크 서버가 시작됩니다.
echo   - 이 창을 닫으면 서버가 종료됩니다 (데이터는 안전하게 보관됨)
echo   - 출석 데이터는 data 폴더에 저장되며 컴퓨터를 꺼도 유지됩니다
echo   - 내일 다시 이 파일을 더블클릭하면 이어서 사용할 수 있습니다
echo  ─────────────────────────────────────────────
echo.
start "" http://localhost:3000
node src\server.js
pause
