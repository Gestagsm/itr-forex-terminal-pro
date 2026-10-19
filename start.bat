@echo off
cd /d "%~dp0"
if not exist "node_modules\xlsx\package.json" (
  goto install
)
if not exist "node_modules\pg\package.json" goto install
if not exist "node_modules\dotenv\package.json" goto install
goto run

:install
echo Installing project dependencies...
call npm install
if errorlevel 1 exit /b 1

:run
call npm start
