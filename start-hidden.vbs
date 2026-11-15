' Starts Studio Board without a console window; supervisor.mjs restarts the server if it ever exits.
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Run "cmd /c node supervisor.mjs >> data\server.log 2>&1", 0, False
