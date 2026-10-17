; SocketAgent server installer for Windows. Build with
; build-windows-server-installer.sh, which stages SupportDir and the icon.
#ifndef SupportDir
  #error SupportDir is required
#endif
#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
[Setup]
AppId={{AFB0C58C-B01C-45D8-8127-B600650866F2}
AppName=SocketAgent Server
AppVersion={#AppVersion}
AppPublisher=Rubano Enterprises, LLC
AppPublisherURL=https://github.com/Yllib/socketagent
; The server runs elevated, and only an elevated setup can register its task.
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
DefaultDirName={autopf}\SocketAgent Server
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableWelcomePage=no
WizardStyle=modern
SetupIconFile={#SupportDir}\app_icon.ico
UninstallDisplayIcon={app}\app_icon.ico
UninstallDisplayName=SocketAgent Server
OutputDir={#SupportDir}\..\packages
OutputBaseFilename=SocketAgent-Server-Setup
Compression=lzma2
SolidCompression=yes
CloseApplications=no
RestartApplications=no
; The setup steps write to the installing user's profile on purpose: the
; server belongs to the Windows account that installs it.
UsedUserAreasWarning=no

[Files]
Source: "server-setup.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "pairing-qr.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SupportDir}\server-bootstrap.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SupportDir}\server-support.zip"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SupportDir}\app_icon.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "server-setup.ps1"; Flags: dontcopy
Source: "{#SupportDir}\server-bootstrap.ps1"; Flags: dontcopy

[UninstallDelete]
Type: files; Name: "{app}\server-location.ini"
Type: filesandordirs; Name: "{app}\server-support"

[Code]
var
  FolderPage, PairPage: TWizardPage;
  StatusText, FolderLabel, PairText: TNewStaticText;
  FolderEdit: TNewEdit;
  BrowseButton, LogButton: TNewButton;
  LogMemo: TNewMemo;
  QrImage: TBitmapImage;
  Progress: TOutputMarqueeProgressWizardPage;
  ExistingDirectory, ServerDirectory, LastError, ProgressTitle: String;
  ServerReady, Detecting: Boolean;

function Quote(const Value: String): String;
begin
  Result := '"' + Value + '"';
end;

function PowerShell: String;
begin
  Result := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
end;

function ResultFile: String;
begin
  Result := ExpandConstant('{tmp}\server-state.ini');
end;

function QrFile: String;
begin
  Result := ExpandConstant('{tmp}\pairing.bmp');
end;

function EnableWindow(Wnd: HWND; Enable: BOOL): BOOL; external 'EnableWindow@user32.dll stdcall';

procedure OnSetupOutput(const S: String; const Error, FirstLine: Boolean);
begin
  // Setup disables its windows while a program runs. Turning the wizard back
  // on lets Show full log work during the install; the page's own buttons
  // stay disabled.
  if FirstLine then EnableWindow(WizardForm.Handle, True);
  if Pos('PHASE:', S) = 1 then
    Progress.SetText(ProgressTitle, Copy(S, 7, Length(S)))
  else if Pos('ERROR:', S) = 1 then
    LastError := Copy(S, 7, Length(S))
  else if Pos('LOG:', S) = 1 then begin
    LogMemo.Lines.Add(Copy(S, 5, Length(S)));
    LogMemo.SelStart := Length(LogMemo.Text);
    SendMessage(LogMemo.Handle, $00B7, 0, 0); // EM_SCROLLCARET keeps the newest line in view
  end;
end;

// The full install output stays hidden behind a button on the progress page.
procedure SetLogVisible(Visible: Boolean);
begin
  LogMemo.Visible := Visible;
  if Visible then LogButton.Caption := 'Hide full log' else LogButton.Caption := 'Show full log';
end;

procedure LogClicked(Sender: TObject);
begin
  SetLogVisible(not LogMemo.Visible);
end;

// Runs one server-setup.ps1 action from Script, which is {tmp} before the
// files are installed and {app} after.
function RunSetup(const Script, Params: String): Boolean;
var
  Code: Integer;
begin
  LastError := '';
  Result := ExecAndLogOutput(PowerShell, '-NoProfile -ExecutionPolicy Bypass -File ' + Quote(Script) + ' ' + Params,
    '', SW_HIDE, ewWaitUntilTerminated, Code, @OnSetupOutput) and (Code = 0);
  if not Result and (LastError = '') then LastError := 'Server setup did not finish.';
end;

// Hiding the progress page returns to the folder page, which would detect
// again forever without the Detecting guard.
procedure DetectServer;
begin
  if Detecting then Exit;
  Detecting := True;
  try
  ProgressTitle := 'Checking this computer';
  Progress.SetText(ProgressTitle, 'Looking for a SocketAgent server installed for your Windows account...');
  Progress.Show;
  Progress.Animate;
  try
    ExistingDirectory := '';
    if RunSetup(ExpandConstant('{tmp}\server-setup.ps1'), '-Action Detect -ResultFile ' + Quote(ResultFile)) then
      ExistingDirectory := GetIniString('server', 'directory', '', ResultFile);
  finally
    Progress.Hide;
  end;
  if ExistingDirectory <> '' then
    StatusText.Caption := 'SocketAgent server is already installed in' + #13#10 + ExistingDirectory + #13#10#13#10 +
      'Setup will update it. Your pairing and chats stay the same.'
  else
    StatusText.Caption := 'Setup installs Node.js, Git, Claude Code and Codex if they are missing, then the server. This can take several minutes.';
  FolderLabel.Visible := ExistingDirectory = '';
  FolderEdit.Visible := FolderLabel.Visible;
  BrowseButton.Visible := FolderLabel.Visible;
  finally
    Detecting := False;
  end;
end;

procedure BrowseClicked(Sender: TObject);
var
  Directory: String;
begin
  Directory := FolderEdit.Text;
  if BrowseForFolder('Choose the server folder', Directory, True) then FolderEdit.Text := Directory;
end;

procedure InitializeWizard;
begin
  ExtractTemporaryFile('server-setup.ps1');
  ExtractTemporaryFile('server-bootstrap.ps1');
  FolderPage := CreateCustomPage(wpWelcome, 'Server folder', 'Where SocketAgent keeps its server files.');
  StatusText := TNewStaticText.Create(FolderPage);
  StatusText.Parent := FolderPage.Surface;
  StatusText.SetBounds(0, 0, FolderPage.SurfaceWidth, ScaleY(80));
  StatusText.AutoSize := False;
  StatusText.WordWrap := True;
  FolderLabel := TNewStaticText.Create(FolderPage);
  FolderLabel.Parent := FolderPage.Surface;
  FolderLabel.SetBounds(0, ScaleY(92), ScaleX(200), ScaleY(17));
  FolderLabel.Caption := 'Server folder';
  FolderEdit := TNewEdit.Create(FolderPage);
  FolderEdit.Parent := FolderPage.Surface;
  FolderEdit.SetBounds(0, ScaleY(114), FolderPage.SurfaceWidth - ScaleX(86), ScaleY(23));
  FolderEdit.Text := ExpandConstant('{param:SERVERDIR|}');
  if FolderEdit.Text = '' then FolderEdit.Text := GetEnv('USERPROFILE') + '\socketagent';
  BrowseButton := TNewButton.Create(FolderPage);
  BrowseButton.Parent := FolderPage.Surface;
  BrowseButton.SetBounds(FolderPage.SurfaceWidth - ScaleX(80), ScaleY(113), ScaleX(80), ScaleY(25));
  BrowseButton.Caption := 'Browse...';
  BrowseButton.OnClick := @BrowseClicked;

  PairPage := CreateCustomPage(wpInfoAfter, 'Pair your phone', 'The server is running.');
  QrImage := TBitmapImage.Create(PairPage);
  QrImage.Parent := PairPage.Surface;
  QrImage.SetBounds(0, 0, PairPage.SurfaceHeight, PairPage.SurfaceHeight);
  PairText := TNewStaticText.Create(PairPage);
  PairText.Parent := PairPage.Surface;
  PairText.SetBounds(PairPage.SurfaceHeight + ScaleX(16), 0, PairPage.SurfaceWidth - PairPage.SurfaceHeight - ScaleX(16), PairPage.SurfaceHeight);
  PairText.AutoSize := False;
  PairText.WordWrap := True;
  PairText.Caption := 'Open SocketAgent on your phone, tap Add computer, and scan this code.' + #13#10#13#10 +
    'To show it again later, run socketagent pair in a new terminal.';
  Progress := CreateOutputMarqueeProgressPage('SocketAgent server', 'Setting up the server');
  LogButton := TNewButton.Create(Progress);
  LogButton.Parent := Progress.Surface;
  LogButton.SetBounds(0, Progress.ProgressBar.Top + Progress.ProgressBar.Height + ScaleY(12), ScaleX(110), ScaleY(25));
  LogButton.OnClick := @LogClicked;
  LogButton.Visible := False;
  LogMemo := TNewMemo.Create(Progress);
  LogMemo.Parent := Progress.Surface;
  LogMemo.SetBounds(0, LogButton.Top + LogButton.Height + ScaleY(8), Progress.SurfaceWidth,
    Progress.SurfaceHeight - LogButton.Top - LogButton.Height - ScaleY(8));
  LogMemo.ReadOnly := True;
  LogMemo.WordWrap := False;
  LogMemo.ScrollBars := ssBoth;
  LogMemo.Font.Name := 'Consolas';
  SetLogVisible(False);
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = FolderPage.ID then DetectServer;
  if (CurPageID = wpFinished) and not ServerReady then
    WizardForm.FinishedLabel.Caption := 'The server did not finish installing.' + #13#10#13#10 + LastError + #13#10#13#10 +
      'Run this setup again to retry. The setup log is in %LOCALAPPDATA%\SocketAgent\setup-logs.';
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := (PageID = PairPage.ID) and not (ServerReady and FileExists(QrFile));
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (CurPageID = FolderPage.ID) and (ExistingDirectory = '') and (Trim(FolderEdit.Text) = '') then begin
    MsgBox('Choose a folder for the server.', mbError, MB_OK);
    Result := False;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Response: Integer;
begin
  if CurStep <> ssPostInstall then Exit;
  ProgressTitle := 'Installing the server';
  LogMemo.Lines.Clear;
  LogButton.Visible := True;
  Progress.Show;
  Progress.Animate;
  try
    repeat
      Progress.SetText(ProgressTitle, 'This can take several minutes. Please leave setup open.');
      ServerReady := RunSetup(ExpandConstant('{app}\server-setup.ps1'), '-Action Install -InstallDirectory ' + Quote(RemoveBackslashUnlessRoot(Trim(FolderEdit.Text))) +
        ' -ResultFile ' + Quote(ResultFile) + ' -QrImage ' + Quote(QrFile) + ' -QrPixels ' + IntToStr(PairPage.SurfaceHeight));
      Response := IDCANCEL;
      if not ServerReady and not WizardSilent then begin
        // Leave the log open behind the error so the cause is on screen.
        SetLogVisible(True);
        Progress.SetText(ProgressTitle, LastError);
        Response := TaskDialogMsgBox('The server did not finish installing', LastError, mbError, MB_RETRYCANCEL, ['Retry', 'Close'], 0);
        if Response = IDRETRY then LogMemo.Lines.Add('--- Retrying ---');
      end;
    until ServerReady or (Response <> IDRETRY);
  finally
    LogButton.Visible := False;
    SetLogVisible(False);
    Progress.Hide;
  end;
  ServerDirectory := GetIniString('server', 'directory', '', ResultFile);
  if ServerDirectory <> '' then
    SetIniString('server', 'directory', ServerDirectory, ExpandConstant('{app}\server-location.ini'));
  if FileExists(QrFile) then begin
    // The QR uses whole pixels per module, so it is usually a little smaller
    // than the space it was drawn for. Fit the box and the text to it.
    QrImage.Bitmap.LoadFromFile(QrFile);
    QrImage.SetBounds(0, 0, QrImage.Bitmap.Width, QrImage.Bitmap.Height);
    PairText.SetBounds(QrImage.Bitmap.Width + ScaleX(16), 0, PairPage.SurfaceWidth - QrImage.Bitmap.Width - ScaleX(16), PairPage.SurfaceHeight);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Code: Integer;
  Directory: String;
begin
  if CurUninstallStep <> usUninstall then Exit;
  Directory := GetIniString('server', 'directory', '', ExpandConstant('{app}\server-location.ini'));
  if not Exec(PowerShell, '-NoProfile -ExecutionPolicy Bypass -File ' + Quote(ExpandConstant('{app}\server-setup.ps1')) + ' -Action Uninstall',
    '', SW_HIDE, ewWaitUntilTerminated, Code) or (Code <> 0) then
    MsgBox('SocketAgent could not stop the server. Stop the SocketAgent task in Task Scheduler, then delete its folder by hand.', mbError, MB_OK)
  else if (Directory <> '') and DirExists(Directory) and not UninstallSilent and
    (MsgBox('The server is stopped and removed from startup.' + #13#10#13#10 + 'Also delete its folder?' + #13#10 + Directory + #13#10#13#10 +
      'This removes its settings and pairing. Chat history in your user folder is kept.', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES) then
    DelTree(Directory, True, True, True);
end;
