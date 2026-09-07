Set objShell = CreateObject("WScript.Shell")
objShell.Run "powershell -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File ""D:\DSH\workspace\knowledge-base\auto-maintain.ps1""", 0, False
