# Dev Notes

## Running the Server Locally

### Launch
```powershell
# Build first
dotnet build AstervoidsWeb/AstervoidsWeb.csproj --configuration Debug

# Launch as a background process (note the PID in output)
$proc = Start-Process -FilePath "dotnet" -ArgumentList "AstervoidsWeb\bin\Debug\net10.0\AstervoidsWeb.dll" -WorkingDirectory "AstervoidsWeb" -PassThru -WindowStyle Hidden; "PID: $($proc.Id)"
```

The server runs at **http://localhost:5000**.

### Stop
```powershell
Stop-Process -Id <PID>
```

### Notes
- Use the DLL directly (`dotnet AstervoidsWeb.dll`), not `dotnet run` — the `dotnet run` wrapper can lose its child process.
- `dotnet watch run --project AstervoidsWeb/AstervoidsWeb.csproj` works for hot reload during development but requires an active terminal session.
