# SocketAgent File Manager Implementation Plan

## Objective

Build a full, safe server-side file manager in the SocketAgent app:

- Browse server folders and files across configured SocketAgent servers.
- Download server files to the phone.
- Upload phone files into selected server folders.
- Rename, delete, create folders, and handle file conflicts.
- Support media-friendly browsing and preview/open flows.
- Integrate protected-file management so the phone can mark/unmark files as agent-protected directly from the browser.
- Let agents include app-native file links in normal text output for browse, reveal, view, and download actions.
- Keep all traffic on the existing authenticated SocketAgent socket path, including relay E2E when relay mode is active.

## Current Code Audit

### Existing Server Capabilities

Relevant files:

- `server/src/index.ts`
- `server/src/protocol.ts`
- `server/plugins/protected-files-plugin.ts`
- `server/src/app-tool-handlers.ts`

Existing filesystem messages:

- `list_directory`
  - Current behavior: returns directory names only.
  - Location: `server/src/index.ts`.
  - Limitations: no files, no metadata, no hidden toggle, no root policy, no protected-file annotations.

- `request_file`
  - Current behavior: reads an arbitrary server file and sends it as base64 `file_chunk` messages followed by `file_complete`.
  - Location: `server/src/index.ts`.
  - Limitations: no file size guard, no operation-specific result message, no resume, no binary server-to-app path.

- `upload_start` / `upload_chunk` / `upload_chunk_bin`
  - Current behavior: uploads phone file chunks to `activeSession.cwd/.uploads`.
  - Location: `server/src/index.ts`.
  - Limitations: cannot choose destination folder, no overwrite policy, no mkdir parent behavior, no operation-specific file manager result.

Existing protected-file support:

- Config path: `~/.socketagent/protected-files.json`.
- App settings UI exists in `app/lib/screens/protected_files_screen.dart`.
- Server index duplicates simple read/write list handling.
- Enforcement currently lives in `server/plugins/protected-files-plugin.ts`.
- Agent accesses go through `canUseToolInterceptor`; direct file-manager server messages do not.

### Existing App Capabilities

Relevant files:

- `app/lib/widgets/folder_browser_screen.dart`
- `app/lib/services/chat_provider.dart`
- `app/lib/widgets/file_card.dart`
- `app/lib/screens/settings/protected_files_screen.dart`
- `app/lib/services/websocket_service.dart`

Existing app filesystem UI:

- `FolderBrowserScreen`
  - Current behavior: folder picker only.
  - Used by session cwd selection and scheduled task cwd selection.
  - Limitations: no files, no actions, no uploads/downloads, no media preview, no protected indicators.

- Download handling in `ChatProvider`
  - Current behavior: tracks server files by `fileId`, writes downloaded files to Android Downloads.
  - Limitations: coupled to `SendFile`/chat card flow, not a general file manager.

- Upload handling in `ChatProvider`
  - Current behavior: file picker attachment upload for chat prompt attachments.
  - Limitations: uploads are tied to prompt send and server writes to `.uploads`.

## Proposed Architecture

### Server Modules

Add a dedicated file manager service:

- `server/src/file-manager.ts`
  - Path resolution and root policy.
  - Directory listing with metadata.
  - File stat/media type helpers.
  - Safe download registration.
  - Mutation operations: mkdir, rename, delete.
  - Upload destination resolution and conflict handling.

Add shared protected-file logic:

- `server/src/protected-files.ts`
  - Move reusable matching and config read/write logic out of plugin/index duplication.
  - Export:
    - `readProtectedFiles()`
    - `writeProtectedFiles(entries)`
    - `matchProtectedPath(path)`
    - `matchProtectedPaths(paths)`
    - `describeProtectedMatch(match)`

Update:

- `server/plugins/protected-files-plugin.ts`
  - Use the shared protected module.
- `server/src/index.ts`
  - Use shared protected module for settings messages and file manager metadata/actions.

### App Modules

Replace/generalize folder picker UI:

- Keep `FolderBrowserScreen` usable as a folder picker.
- Add `app/lib/screens/file_manager_screen.dart` or convert `FolderBrowserScreen` into mode-based UI:
  - `mode: picker | manager`
  - Manager mode shows files and actions.
  - Picker mode remains low-risk for cwd selection.

Add models:

- `app/lib/models/file_manager_entry.dart`
- `app/lib/models/file_manager_operation.dart`
- `app/lib/models/file_manager_link.dart`

Update `ChatProvider`:

- Add request/response completers for file manager operations.
- Add per-file upload/download progress maps keyed by operation id.
- Keep existing chat `SendFile` cards working unchanged.

Update chat rendering:

- Intercept SocketAgent file links in assistant text.
- Route link taps to the file manager screen or direct file operation.
- Keep normal web links working unchanged.

## Protocol Design

Use explicit file-manager message names instead of overloading old cwd/file messages too much.

### Client -> Server

```ts
type FileManagerListMessage = {
  type: "file_manager_list";
  requestId: string;
  path?: string;
  includeHidden?: boolean;
};

type FileManagerDownloadMessage = {
  type: "file_manager_download";
  requestId: string;
  path: string;
};

type FileManagerMkdirMessage = {
  type: "file_manager_mkdir";
  requestId: string;
  path: string;
};

type FileManagerRenameMessage = {
  type: "file_manager_rename";
  requestId: string;
  fromPath: string;
  toName: string;
};

type FileManagerDeleteMessage = {
  type: "file_manager_delete";
  requestId: string;
  path: string;
  recursive?: boolean;
};

type FileManagerUploadStartMessage = {
  type: "file_manager_upload_start";
  uploadId: string;
  targetDir: string;
  fileName: string;
  fileSize: number;
  totalChunks: number;
  chunkSize: number;
  conflictPolicy: "fail" | "rename" | "overwrite";
};

type FileManagerSetProtectedMessage = {
  type: "file_manager_set_protected";
  requestId: string;
  path: string;
  protected: boolean;
  label?: string;
  pattern?: "exact" | "directory";
};
```

Existing `upload_chunk` and `upload_chunk_bin` can remain the chunk transport, but upload state must know whether the upload came from chat attachment or file manager.

### Server -> Client

```ts
type FileManagerEntry = {
  name: string;
  path: string;
  kind: "directory" | "file" | "symlink" | "other";
  size?: number;
  modifiedAt?: string;
  hidden: boolean;
  extension?: string;
  mimeType?: string;
  mediaKind?: "image" | "video" | "audio" | "text" | "archive" | "code" | "other";
  protected: boolean;
  protectedLabel?: string;
};

type FileManagerListResult = {
  type: "file_manager_list_result";
  requestId: string;
  ok: boolean;
  path: string;
  parentPath?: string;
  entries: FileManagerEntry[];
  roots?: Array<{ label: string; path: string }>;
  error?: string;
};

type FileManagerOperationResult = {
  type: "file_manager_operation_result";
  requestId: string;
  operation: "download" | "mkdir" | "rename" | "delete" | "upload_start";
  ok: boolean;
  path?: string;
  newPath?: string;
  fileId?: string;
  error?: string;
};

type FileManagerProtectedResult = {
  type: "file_manager_protected_result";
  requestId: string;
  ok: boolean;
  path: string;
  protected: boolean;
  entry?: { path: string; label?: string };
  error?: string;
};
```

Downloads can reuse existing `file_chunk` and `file_complete` once the server returns a `fileId`.

## Agent File Links

Use custom Markdown links rather than HTML-like tags. Markdown links already render naturally in assistant text, and Flutter Markdown can intercept link taps.

Recommended URI scheme:

```md
[open config](socketagent://file/view?path=%2Fhome%2Frdp%2Fproject%2Fconfig.json)
[show folder](socketagent://file/browse?path=%2Fhome%2Frdp%2Fproject)
[reveal config](socketagent://file/reveal?path=%2Fhome%2Frdp%2Fproject%2Fconfig.json)
[download build](socketagent://file/download?path=%2Fhome%2Frdp%2Fproject%2Fbuild.apk)
```

Supported actions:

- `browse`: open file manager at a directory path.
- `reveal`: open file manager at the parent directory and highlight/select the file.
- `view`: open preview flow for a file; image/text preview where supported, otherwise download/open.
- `download`: start the file-manager download flow for the file.
- `protect`: optional later action to open the protect/unprotect sheet for the path.

Server targeting:

- If the link has `serverId`, use that server.
- If omitted, use the message/session server context.
- If no server context is available and multiple servers exist, show a server picker.

Encoding rules:

- `path` must be URL-encoded.
- Links are inert until tapped; the agent cannot force a download by merely printing text.
- The app must reject unsupported schemes/actions and show a small error snackbar.

Why not HTML tags:

- Flutter Markdown already supports link callbacks.
- Markdown links are readable in raw history.
- Agents naturally know how to emit Markdown.
- Custom HTML-ish tags would need a separate parser and are more brittle in streamed text.

## Safety Model

### Root Policy

Implement a root policy before mutations:

- Default roots:
  - `DEFAULT_CWD`
  - user home directory
  - recent CWDs from SocketAgent session metadata
- Optional env override:
  - `FILE_MANAGER_ROOTS=/home/rdp/claude,/tmp`
  - `FILE_MANAGER_ALLOW_ABSOLUTE=true` for owner-only unrestricted browsing if wanted.

Every file-manager path should be resolved with `path.resolve` and `fs.realpathSync.native` where possible. For new paths that do not exist yet, realpath the nearest existing parent and validate the final path remains under an allowed root unless absolute mode is enabled.

### Protected-File Integration

Protected files are an agent-control feature, not a phone file-manager access-control feature.

The phone is treated as the user and may browse, download, upload, rename, and delete files normally after the usual app confirmations. Protected rules should not block phone-initiated file-manager operations.

File-manager integration means:

- Directory listings include `protected` and `protectedLabel` metadata.
- File/folder rows show a shield indicator when they match a protected rule.
- Row actions include:
  - `Protect exact path`
  - `Protect folder recursively`
  - `Remove protection` when the selected path maps to a removable exact/directory rule
- The existing Protected Files settings screen still works.
- Agent tool use continues to be blocked/approved by the protected-files plugin.

Implementation detail:

- Move protected matching/list mutation into `server/src/protected-files.ts`.
- The plugin uses this module for agent enforcement.
- The file manager uses this module only for metadata and mark/unmark actions.
- No `protectedConfirmationId` is needed for normal file operations.

### Dangerous Operations

Delete and overwrite need explicit app confirmation:

- Delete file: confirm.
- Delete non-empty directory: confirm and show item count when practical.
- Overwrite upload target: confirm unless conflict policy is `rename`.
- Rename over existing target: block unless a later overwrite flow is added.

### Symlink Handling

Directory listings should identify symlinks.

Default behavior:

- Follow symlinks for browsing only after resolving realpath under allowed roots.
- Deny symlink traversal outside allowed roots unless `FILE_MANAGER_ALLOW_ABSOLUTE=true`.
- For delete, delete the symlink itself, not the resolved target.

## Media Support

Phase 1 should classify media by extension/MIME:

- image: jpg, jpeg, png, gif, webp, bmp
- video: mp4, mov, mkv, webm
- audio: mp3, wav, m4a, ogg, flac
- text/code: common text extensions plus small UTF-8 files
- archive: zip, tar, gz, 7z

Initial UX:

- Images: preview by downloading to app temp/cache and showing in an image viewer with zoom.
- Video/audio: download/open with Android intent via existing file opening path, or show an `Open after download` action.
- Text/code: optional read-only preview for files below a safe size, for example 512 KB.

Later UX:

- Thumbnail cache for image files.
- Inline audio/video player if we add packages.

## UI Design

### Entry Points

Add a File Manager entry in Settings or main shell navigation:

- Settings -> Server Files
- Optional session overflow action: `Browse Files`
- Optional scheduled task cwd picker continues using folder-picker mode.

### File Manager Screen

Primary screen:

- App bar: server selector, refresh, hidden toggle, sort menu.
- Path/breadcrumb row.
- Root chips for home/default/recent folders.
- List rows with stable density:
  - icon/type
  - name
  - size + modified date
  - protected shield indicator
  - overflow menu

Actions:

- Folder tap: navigate.
- File tap:
  - image -> preview
  - other -> action sheet: Download, Open, Rename, Delete
- Long press: selection mode for delete/download later.
- FAB or toolbar upload action:
  - pick file(s)
  - choose conflict policy
  - upload into current directory
- Create folder action.

### File Links from Chat

When assistant text includes `socketagent://file/...` links:

- Render them as normal clickable Markdown links.
- On tap, parse the URI into a `FileManagerLink`.
- Navigate to the file manager with:
  - initial server
  - initial path
  - optional highlighted entry
  - optional initial action (`download` or `view`)
- Direct destructive actions are not supported from links.
- Download/view links can still show large-file/media confirmations as needed.

### Existing Folder Picker Compatibility

Do not break cwd picking:

- `FolderBrowserScreen(mode: picker)` keeps current select-folder behavior.
- File-manager mode can use the same backend API but richer UI.

## Implementation Phases

## Current Implementation Status

Last updated: 2026-06-20.

- Phase 1: implemented. Server has shared `protected-files.ts`, `file-manager.ts`, root validation, metadata listing, and file-manager protect/unprotect. The protected-files plugin now uses the shared protected config/matcher.
- Phase 2: mostly implemented. App has file-manager models, Settings -> Server Files entry, server selector, roots, path navigation, hidden toggle, current-folder search, remembered last path per server, protected shields, and mark/unmark actions. Sort UI is still pending.
- Phase 3: partially implemented. Server/app download is wired through existing chunk transfer. Assistant Markdown links using `socketagent://file/browse`, `reveal`, `view`, and `download` are intercepted in chat bubbles. Browse/reveal/view currently open the file manager; download starts the file-manager download. File rows now open a media-aware action sheet, downloaded files can be opened through Android, and text/code files have capped in-app preview. Image/video/audio inline preview and highlighted reveal selection are still pending.
- Phase 4: partially implemented. Upload into selected folder is wired with `rename` conflict policy. Overwrite/fail policy UI and richer upload progress in the file-manager screen are still pending.
- Phase 5: initially implemented. Create folder, rename, and delete are wired with delete confirmation. Recursive count preview and stronger destructive-operation copy are still pending.
- Safety note: Root checks now validate real paths. Symlink traversal outside allowed roots is blocked unless `FILE_MANAGER_ALLOW_ABSOLUTE=true`.
- Validation so far: `server npx tsc`, `server npx tsc -p plugins/tsconfig.json`, `app flutter analyze` with existing baseline warnings only, and Node smoke tests for listing/hidden/protected metadata plus symlink escape blocking.

### Phase 1: Shared Server File Manager Core

Deliverables:

- Add `server/src/protected-files.ts`.
- Add `server/src/file-manager.ts`.
- Refactor protected-files plugin and index protected settings handlers to use shared protected module.
- Add server-side path/root validation helpers.
- Add `file_manager_list` with full `FileManagerEntry` metadata.
- Add `file_manager_set_protected` for mark/unmark actions.

Tests:

- `npx tsc`.
- Node smoke script with temp directory:
  - lists files and folders
  - hidden toggle works
  - path traversal is blocked
  - symlink outside root is blocked
  - protected entries are marked
  - mark/unmark protected updates metadata

### Phase 2: App File Manager Read-Only Browser

Deliverables:

- Add app file manager models.
- Add `ChatProvider.fileManagerList`.
- Add manager screen with server selector, path navigation, sort, hidden toggle.
- Preserve existing folder-picker behavior.

Tests:

- `flutter analyze`.
- Manual app test:
  - browse home/default cwd
  - switch servers
- hidden toggle
- protected shield display
- mark/unmark protected from file row action

### Phase 3: Download and Media Preview

Deliverables:

- Add `file_manager_download`.
- Reuse existing chunked file transfer for saving to Downloads.
- Add `socketagent://file/...` chat link parsing and route `browse`, `reveal`, `view`, and `download`.
- Add preview/open flow:
  - image preview for downloaded temp file
  - open external app for other media
  - optional small text preview

Safety:

- Large file warning threshold, for example 100 MB.
- Protected status is displayed, but does not block phone downloads.

Tests:

- Download text, image, binary file.
- Protected files download normally from the phone.
- Assistant Markdown file links navigate to browse/reveal/view/download flows.
- Download over direct and relay connections.

### Phase 4: Upload to Selected Folder

Deliverables:

- Extend upload state to support `targetDir`.
- Add `file_manager_upload_start`.
- Add conflict policies:
  - fail
  - rename
  - overwrite with confirmation
- Add upload progress UI scoped to file manager screen.

Safety:

- Validate target directory server-side.
- Sanitize `fileName` and block path separators.
- Protected status is displayed, but does not block phone uploads.

Tests:

- Upload small and large files.
- Upload to protected path works from the phone after normal overwrite confirmation.
- Conflict policies work.
- Existing chat attachment upload still writes to `.uploads` unchanged.

### Phase 5: Rename, Delete, Create Folder

Deliverables:

- Add mkdir, rename, delete operations.
- Add result handling and UI refresh.
- Add confirmations:
  - delete always confirms
  - recursive directory delete confirms with count if available
- protected status is shown in the confirmation copy, but does not block the phone operation

Safety:

- Block rename over existing destination for first version.
- For recursive delete, cap pre-scan to avoid huge tree hangs. If count exceeds cap, show `1000+ items`.

Tests:

- Rename file/folder.
- Delete file/empty folder/non-empty folder.
- Protected delete/rename works from the phone after normal destructive confirmation.
- Symlink delete deletes link, not target.

### Phase 6: Polish and Persistence

Deliverables:

- Remember last path per server.
- Add search/filter within current folder.
- Add empty/error states.
- Add operation snackbars.
- Add retry for failed upload/download.
- Add multi-select if useful.

Tests:

- App lifecycle: leave screen mid-upload/download and return.
- Reconnect during browsing.
- Multiple servers with different roots.

## Testing Strategy

### What Codex Can Test

- Server compile: `cd server && npx tsc`.
- App static analysis: `cd app && flutter analyze`.
- Remote APK build through `build-app.sh` only.
- Server smoke/integration tests against temp directories.
- WebSocket protocol tests with a local authenticated server if safe to start in a separate port.
- Direct filesystem safety tests for root/symlink behavior and protected metadata/action behavior.

### What Needs Phone/App Testing

I cannot reliably validate Android visual UX without your installed app/device interaction. You will need to test:

- Navigation density and touch ergonomics.
- Media preview/open behavior.
- Android file picker/upload behavior.
- Download save locations.
- Permission prompts and Android install/open intents.
- Relay performance for large files.

### Manual Test Checklist

- Browse default cwd.
- Browse home folder.
- Switch between servers.
- Toggle hidden files.
- Tap assistant-generated browse/reveal/view/download links.
- Download a small text file.
- Download a large binary file.
- Preview an image.
- Upload into a normal folder.
- Upload into a folder with existing filename using rename policy.
- Try overwrite policy and confirm.
- Add protected rule for a temp file from file manager.
- Remove protected rule from file manager.
- Verify protected files still download from the phone.
- Verify protected files still block/ask for agent tool use.
- Delete a non-empty temp directory.
- Verify cwd picker screens still work.
- Verify chat attachment upload still works.

## Risks and Mitigations

- Large file transfer over JSON/base64 is inefficient.
  - Mitigation: keep current chunking for MVP; later add server-to-app binary frames.

- Protected status could be misunderstood as blocking phone actions.
  - Mitigation: UI copy says protection applies to agents, not the phone file manager.

- Symlinks can escape allowed roots.
  - Mitigation: realpath validation and explicit symlink handling.

- Deleting directories is high risk.
  - Mitigation: confirmation, recursive count, no background auto-delete.

- Existing folder picker may regress.
  - Mitigation: keep picker mode separate and test scheduled task/session cwd flows.

## Recommended Start

Start with Phase 1 and Phase 2 together:

1. Build safe server listing and shared protected matching/actions.
2. Build read-only file manager UI.
3. Test browsing and protected indicators/mark-unmark actions.

Once read-only browsing is solid, add downloads, then uploads, then destructive operations.
