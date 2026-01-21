@echo off
setlocal

cd /d "%~dp0"

set PORT=4000
set NGROK_AUTHTOKEN=
if exist ".env" (
  for /f "usebackq tokens=1* delims==" %%A in (".env") do (
    if /i "%%A"=="PORT" set PORT=%%B
    if /i "%%A"=="NGROK_AUTHTOKEN" set NGROK_AUTHTOKEN=%%B
  )
)

set NODE_ENV=production

if not exist "node_modules" (
  echo Installing dependencies...
  npm install
)

if not exist "dist" (
  echo Building frontend...
  npm run build
)

start "" /b powershell -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:%PORT%'"

where ngrok >nul 2>nul
if %errorlevel%==0 (
  if not "%NGROK_AUTHTOKEN%"=="" (
    ngrok config add-authtoken %NGROK_AUTHTOKEN% >nul 2>nul
  )
  echo Starting ngrok tunnel...
  start "" cmd /k "ngrok http %PORT%"
  start "" /b powershell -NoProfile -Command "$tries=0; while($tries -lt 10){try{$resp=Invoke-RestMethod http://127.0.0.1:4040/api/tunnels; $url=$resp.tunnels[0].public_url; if($url){Start-Process $url; break}}catch{}; Start-Sleep -Seconds 1; $tries++}"
) else (
  echo ngrok not found. Install ngrok or add it to PATH to enable public access.
)
echo Starting server on port %PORT%...
npm start
