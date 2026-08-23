@echo off
REM ModelPulseX — local dev (Windows)
REM Requires Node 20+, Cloudflare account for deploy but not for local D1/Queue/DO via --local
REM Usage: run.bat  or  run.bat --remote
setlocal
cd /d "%~dp0"
echo [ModelPulseX] installing deps (legacy peer deps for wrangler)...
call npm install --legacy-peer-deps
if errorlevel 1 goto :eof
echo [ModelPulseX] applying D1 migrations (local)...
call npx wrangler d1 migrations apply DB --local
if errorlevel 1 goto :eof
echo [ModelPulseX] building frontend...
call npm run build
if errorlevel 1 goto :eof
echo [ModelPulseX] starting wrangler dev --local on :8789  (Ctrl+C to stop)
echo   - API: http://127.0.0.1:8789/api/health
echo   - Dashboard: http://127.0.0.1:8789/
echo   - Live SSE: http://127.0.0.1:8789/api/live
echo   - Admin discover: curl -X POST http://127.0.0.1:8789/api/admin/discover -H "Authorization: Bearer %ADMIN_TOKEN%"
if "%~1"=="--remote" (
  npx wrangler dev --remote --port 8789
) else (
  npx wrangler dev --local --port 8789
)
