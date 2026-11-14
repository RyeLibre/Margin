@echo off
rem Double-click to install (or update) Margin. No admin rights needed.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
if errorlevel 1 pause
