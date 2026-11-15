' Desktop launcher: starts Studio Board without a console window (or finds it already running) and opens it.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
If Not fso.FolderExists(dir & "\data") Then fso.CreateFolder(dir & "\data")
sh.CurrentDirectory = dir
' supervisor.mjs exits at once when the port is taken by a running copy
sh.Run "cmd /c node supervisor.mjs >> data\server.log 2>&1", 0, False
WScript.Sleep 1200
sh.Run "http://127.0.0.1:4777/"
