@echo off
rem Makes Margin.zip in this folder to give to friends (the app only, none of your books or notes).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0share.ps1"
pause
