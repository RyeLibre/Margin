@echo off
rem Builds Margin.exe from this folder and installs it (or updates it). No admin rights needed.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 pause
