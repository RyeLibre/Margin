' Margin Reader - opens Margin in its own window (used by LibreOS and the desktop shortcut).
' Starts the small local server out of sight, then opens Margin as an app window in your
' default browser (Chrome or Edge), so your books and notes stay where they already are.
Option Explicit
Dim sh, fso, here, url, prog, browser, http, i, ok
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
url = "http://localhost:8765/"

' 0. the Margin app (Margin.exe) when it's installed - LibreOS and old shortcuts then open it
Dim appExe
appExe = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\Margin\Margin.exe"
If fso.FileExists(appExe) Then
  sh.Run Chr(34) & appExe & Chr(34), 1, False
  WScript.Quit
End If

' 1. start the server hidden (it quits by itself if it is already running)
sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & here & "\server.ps1"" -NoBrowser", 0, False

' 2. wait until it answers (up to about 10 seconds)
ok = False
For i = 1 To 40
  On Error Resume Next
  Set http = CreateObject("MSXML2.XMLHTTP")
  http.Open "GET", url & "icon.svg", False
  http.Send
  If Err.Number = 0 Then
    If http.Status = 200 Then ok = True
  End If
  On Error GoTo 0
  If ok Then Exit For
  WScript.Sleep 250
Next

' 3. open the app window in the default browser
prog = ""
On Error Resume Next
prog = sh.RegRead("HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice\ProgId")
On Error GoTo 0
If InStr(1, prog, "Chrome", vbTextCompare) > 0 Then
  browser = "chrome"
Else
  browser = "msedge"
End If
On Error Resume Next
sh.Run browser & " --app=" & url, 1, False
If Err.Number <> 0 Then
  Err.Clear
  sh.Run url, 1, False
End If
