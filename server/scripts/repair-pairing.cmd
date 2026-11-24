@echo off
rem Opened by Repair now on the pairing repair toast. %1 is the node.exe the
rem server runs on. See scripts\pairing-repair-toast.ps1.
title SocketAgent repair
echo SocketAgent can't accept connections because its pairing file is damaged.
echo.
echo Repair starts pairing over. Phones and other computers will have to scan
echo the new code shown here. SocketAgent on this computer reconnects by itself.
echo.
echo Press any key to repair, or close this window to cancel.
pause >nul
echo.
"%~1" "%~dp0show-pairing.js" --reset
