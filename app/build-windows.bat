@echo off
rem Builds dist\privatewebchat.exe: one file, nothing to install beside it.
rem Run from "x64 Native Tools Command Prompt for VS" (Visual Studio or its free Build Tools).
setlocal
cd /d "%~dp0"
if not exist build mkdir build
if not exist dist mkdir dist
set WV2=build\webview2\build\native\include
if not exist %WV2%\WebView2.h (
  curl -sSL -o build\webview2.zip https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/1.0.4258.31 || goto :fail
  powershell -NoProfile -Command "Expand-Archive -Force build\webview2.zip build\webview2" || goto :fail
)
set CFLAGS=/nologo /O2 /MT /utf-8 /D_CRT_SECURE_NO_WARNINGS /DWEBVIEW_STATIC /Ivendor\webview /Ibuild /Isrc
cl /nologo /O2 /D_CRT_SECURE_NO_WARNINGS src\embed.c /Fe:build\embed.exe /Fo:build\embed.obj || goto :fail
build\embed.exe build\ui.h ui index.html style.css config.js protocol.js vault.js app.js || goto :fail
cl %CFLAGS% /EHsc /std:c++17 /w /I%WV2% /c src\webview.cc /Fo:build\webview.obj || goto :fail
cl %CFLAGS% /c src\main.c /Fo:build\main.obj || goto :fail
cl %CFLAGS% /c src\platform_win.c /Fo:build\platform_win.obj || goto :fail
rc /nologo /fo build\app.res win\app.rc || goto :fail
link /nologo /OUT:dist\privatewebchat.exe /SUBSYSTEM:WINDOWS /ENTRY:mainCRTStartup build\webview.obj build\main.obj build\platform_win.obj build\app.res ^
  ws2_32.lib bcrypt.lib crypt32.lib advapi32.lib ole32.lib shell32.lib shlwapi.lib user32.lib version.lib || goto :fail
echo Built dist\privatewebchat.exe
exit /b 0
:fail
echo Build failed
exit /b 1
