@echo off
rem Removes Margin and its shortcuts. Asks before deleting your books, notes and saved words.
choice /m "Remove Margin from this PC"
if errorlevel 2 exit /b
taskkill /im Margin.exe /f >nul 2>&1
timeout /t 2 /nobreak >nul
rmdir /s /q "%LOCALAPPDATA%\Programs\Margin"
del "%USERPROFILE%\Desktop\Margin.lnk" >nul 2>&1
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Margin.lnk" >nul 2>&1
choice /m "Also delete your books, highlights, notes, saved words and the voice"
if errorlevel 2 goto done
rmdir /s /q "%LOCALAPPDATA%\Margin"
:done
echo Margin has been removed.
pause
