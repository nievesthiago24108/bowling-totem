@echo off
rem Bowling Totem: arranca el servidor y abre el totem en pantalla completa (modo kiosco).
rem Uso: doble clic. Para salir del kiosco: Alt+F4. Para apagar el juego, cerrar la ventana
rem "Bowling Totem - servidor".
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto sin_node

if exist node_modules goto instalado
echo Instalando dependencias (solo la primera vez)...
call npm install --omit=dev
if errorlevel 1 goto sin_internet
:instalado

for /f "delims=" %%p in ('node -p "require('./server.js').loadConfig().puerto"') do set PUERTO=%%p
set URL=http://localhost:%PUERTO%

rem el servidor se vuelve a levantar solo si se cae
start "Bowling Totem - servidor" /min cmd /c "for /l %%i in () do (node server.js & echo El servidor se detuvo; se reinicia en 2 segundos... & ping -n 3 127.0.0.1 >nul)"

rem esperar a que el servidor responda (max. 20 s)
set /a INTENTOS=0
:esperar
node -e "require('http').get('%URL%/api/config',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" >nul 2>nul
if not errorlevel 1 goto listo
set /a INTENTOS+=1
if %INTENTOS% GEQ 20 goto no_responde
ping -n 2 127.0.0.1 >nul
goto esperar
:listo

set NAVEGADOR=
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set NAVEGADOR=%ProgramFiles%\Google\Chrome\Application\chrome.exe
if not defined NAVEGADOR if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set NAVEGADOR=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe
if not defined NAVEGADOR if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set NAVEGADOR=%LocalAppData%\Google\Chrome\Application\chrome.exe
if not defined NAVEGADOR if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set NAVEGADOR=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe
if not defined NAVEGADOR if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set NAVEGADOR=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe
if not defined NAVEGADOR goto sin_navegador

rem Perfil propio: el kiosco funciona aunque el navegador ya este abierto y suena sin tocar la pantalla.
start "" "%NAVEGADOR%" --kiosk --autoplay-policy=no-user-gesture-required --noerrdialogs --disable-infobars --no-first-run --disable-session-crashed-bubble --disable-features=Translate --user-data-dir="%LocalAppData%\bowling-totem-kiosco" %URL%
exit /b 0

:sin_navegador
echo No encontre Chrome ni Edge. Abri %URL% a mano y toca F para pantalla completa.
start "" %URL%
pause
exit /b 0

:no_responde
echo El servidor no respondio en %URL%. Mira la ventana "Bowling Totem - servidor".
pause
exit /b 1

:sin_node
echo Falta Node.js 20 o superior. Bajalo de https://nodejs.org (version LTS) y volve a intentar.
pause
exit /b 1

:sin_internet
echo No se pudieron instalar las dependencias. Hace falta internet la primera vez.
pause
exit /b 1
