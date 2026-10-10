' Neo Studio desktop shell entry point (double-click, no console window).
' pythonw has no console, so the shell reports through dialog boxes and tmp/studio_shell.log.
' neo-studio-app.bat is the debug entry that keeps a visible console.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
' Integrated-pack layout first (python beside ComfyUI), then ComfyUI inner python
py = fso.BuildPath(fso.GetParentFolderName(fso.GetParentFolderName(fso.GetParentFolderName(dir))) & "\python", "pythonw.exe")
If Not fso.FileExists(py) Then py = fso.BuildPath(fso.GetParentFolderName(dir) & "\python", "pythonw.exe")
If Not fso.FileExists(py) Then
    MsgBox "pythonw.exe not found. Run neo-studio-app.bat -Python <python.exe>, or edit this script.", 0, "Neo Studio"
Else
    sh.Run """" & py & """ """ & fso.BuildPath(dir, "neo_studio_app.py") & """", 1, False
End If