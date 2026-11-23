; Inno Setup script - builds a single "Next, Next, Finish" installer from the portable folder.
; Built by the GitHub Actions workflow (.github/workflows/release.yml); locally:
;   ISCC.exe /DAppVersion=1.0.0 installer\EDAStudio.iss

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{B7E3C1A4-5D2F-4E8B-9A61-3F0D8C2E7A15}
AppName=EDA Studio
AppVersion={#AppVersion}
AppPublisher=EladOzCohen
AppPublisherURL=https://github.com/EladOzCohen/EDA_Factory
AppSupportURL=https://github.com/EladOzCohen/EDA_Factory/issues
; Per-user install: no administrator rights, no UAC prompt.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
DefaultDirName={autopf}\EDA Studio
DisableProgramGroupPage=yes
DisableDirPage=auto
OutputDir=..\release
OutputBaseFilename=EDAStudio-Setup-{#AppVersion}
SetupIconFile=EDAStudio.ico
UninstallDisplayIcon={app}\EDAStudio.exe
UninstallDisplayName=EDA Studio
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
CloseApplications=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
Source: "..\portable\EDAStudio\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\EDA Studio"; Filename: "{app}\EDAStudio.exe"
Name: "{autodesktop}\EDA Studio"; Filename: "{app}\EDAStudio.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\EDAStudio.exe"; Description: "Start EDA Studio now"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}"
