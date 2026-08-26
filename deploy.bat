@echo off
REM ModelPulseX — deploy to Cloudflare
REM Prerequisites:
REM   wrangler login   (or CLOUDFLARE_API_TOKEN env)
REM   wrangler d1 create modelpulsex-db  (once) -> paste database_id into wrangler.jsonc
REM   wrangler secret put OPENCODE_API_KEY
REM   wrangler secret put OPENROUTER_API_KEY
REM   wrangler secret put ADMIN_TOKEN
setlocal
cd /d "%~dp0"
echo [ModelPulseX] typecheck + tests...
call npm run typecheck
if errorlevel 1 goto :eof
call npm test
if errorlevel 1 goto :eof
echo [ModelPulseX] build...
call npm run build
if errorlevel 1 goto :eof
echo [ModelPulseX] D1 migrations (remote)...
call npx wrangler d1 migrations apply DB --remote
if errorlevel 1 goto :eof
echo [ModelPulseX] deploy...
call npx wrangler deploy
if errorlevel 1 goto :eof
echo [deploy done] Check https://modelpulsex.vipulgote5.workers.dev/api/health
