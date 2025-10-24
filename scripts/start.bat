@echo off
setlocal ENABLEDELAYEDEXPANSION

set ROOT_DIR=%~dp0..
set PB_TEMPLATES_DIR=%ROOT_DIR%\config\templates
set PORTABLE_NODE=%ROOT_DIR%\mcp-sandbox\runtimes\nodejs\bin\node.exe

if exist "%PORTABLE_NODE%" (
  set NODE_BIN=%PORTABLE_NODE%
) else (
  set NODE_BIN=node
)

if not exist "%ROOT_DIR%\dist" (
  echo [build] Compiling TypeScript...
  pushd "%ROOT_DIR%"
  call npm run build
  popd
)

"%NODE_BIN%" "%ROOT_DIR%\dist\index.js"

