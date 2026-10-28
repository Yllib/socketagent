# AI connector

Lets Claude (claude.ai, the desktop app, Claude Code) or ChatGPT use your
SocketAgent computers through MCP. You host it yourself. SocketAgent runs no
service for it, the relay never sees it, and the only copies of the tokens are
on the computer you turn it on.

What a connected AI client can do, through one computer and every computer that
computer is linked to:

- list computers
- run a command
- list sessions, read a transcript, search transcripts
- start an agent, message it, check its status, list agents, stop one

Every action lands in a session named after the client, for example "Claude via
AI connector", so you can read what it did. Each computer keeps its own
approval cards. By default the client's first action on a computer raises a
card on your phone that names the client, and you can allow once, allow for the
rest of that chat, or deny. "Ask before each action" can be turned off per
client under Devices.

## Turn it on

1. Pick the computer that will host it. On the phone open Settings, that
   computer, Devices, AI connector.
2. Run a tunnel on that computer that forwards an HTTPS address to
   `http://127.0.0.1:8086` (change the port there if you need to). See
   [cloudflared](#cloudflare-tunnel) below. Tailscale Funnel, ngrok or a
   reverse proxy work the same way.
3. Enter the HTTPS address, turn the switch on, save. The screen shows the
   MCP URL, which is the address plus `/mcp`.
4. In Claude: Settings, Connectors, Add custom connector, paste the MCP URL.
   In ChatGPT: Settings, Connectors, Create (developer mode), paste the MCP
   URL, authentication OAuth.
5. The client opens a sign-in page. The page and your phone both show a six
   digit code. Approve on the phone when they match.

That is all. The client is now listed under Devices as an AI client. Remove it
there to sign it out at once.

## What is reachable

The connector listens on 127.0.0.1 only, on its own port, and that listener
serves nothing but:

| Route | Purpose |
| --- | --- |
| `/mcp` | MCP over streamable HTTP, bearer token required |
| `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration` | discovery |
| `/oauth/register` | dynamic client registration |
| `/oauth/authorize`, `/oauth/authorize/wait` | the sign-in page |
| `/oauth/token`, `/oauth/revoke` | tokens |

The app WebSocket, file manager, Codex MCP and everything else stay on the main
port and are never served there, so a tunnel that forwards the whole port
exposes nothing else. Clients that are not signed in get a 401 and the
discovery documents, nothing more.

## How sign-in works

- OAuth 2.1 with PKCE (S256 only), as the MCP authorization spec requires.
  Claude and ChatGPT register themselves through dynamic client registration,
  or identify themselves with a client ID metadata document. No passwords, no
  third party identity provider.
- The authorize page never asks you anything. It waits while your phone shows
  the approval card. Approving issues that client its own tokens.
- Access tokens last one hour. Refresh tokens last 30 days and rotate on every
  use. Reusing an old refresh token revokes the whole grant.
- Tokens are stored hashed in `ai-connector.json` in the SocketAgent data
  directory, readable by the owner only. Nothing in that file lets anyone
  sign in.
- Sign-in requests are capped at three waiting at a time and every route is
  rate limited, so a stranger who finds the URL can at most make your phone
  show a card you deny.

## Cloudflare Tunnel

`docs/ai-connector/cloudflared.yml` is a complete config. Install `cloudflared`,
run `cloudflared tunnel login`, `cloudflared tunnel create socketagent`, put the
tunnel ID and credentials path in the file, add the DNS route with
`cloudflared tunnel route dns socketagent agent.example.com`, and run it as a
service (`cloudflared service install`). Only the one hostname is forwarded, and
only to the connector port.

## Claude Code

Claude Code can use the same URL:

```
claude mcp add --transport http socketagent https://agent.example.com/mcp
```

Its sign-in callback is a loopback address on a random port, which the
connector accepts for registered loopback redirect URIs.
