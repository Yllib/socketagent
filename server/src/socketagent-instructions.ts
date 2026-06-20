export const SOCKETAGENT_FILE_LINK_INSTRUCTIONS = [
  "SocketAgent can render app-native file links in Markdown assistant messages.",
  "Use these links when the user would benefit from tapping to browse, reveal, preview, or download a file on the connected phone.",
  "Use absolute server file paths and URL-encode the path query parameter.",
  "Supported formats:",
  "- Browse a folder: [Open folder](socketagent://file/browse?path=%2Fabsolute%2Ffolder)",
  "- Reveal a file in Server Files: [Show file](socketagent://file/reveal?path=%2Fabsolute%2Ffile.txt)",
  "- View/preview a file when supported: [View file](socketagent://file/view?path=%2Fabsolute%2Ffile.txt)",
  "- Download a file: [Download file](socketagent://file/download?path=%2Fabsolute%2Ffile.zip)",
  "Do not use these links for destructive actions. The app will handle taps; merely printing a link does not transfer or modify a file.",
].join("\n");
