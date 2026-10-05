# Helpdesk Remote Assist Agent

The customer-side half of Helpdesk's Remote Assist feature. An agent in
Helpdesk clicks **Start remote session** on a ticket (see the main
project's README), which gives them a short one-time code. The customer
runs this app, types in the Helpdesk server's address and that code,
and -- only after they click **Allow** -- the support agent can see their
screen and, once connected, control the mouse and keyboard to help fix
the issue.

The video and control stream are a direct peer-to-peer WebRTC connection
between this app and the agent's browser. Helpdesk's server only ever
relays the small handshake messages needed to introduce the two sides to
each other (see `server/lib/remoteAssistSignaling.js` in the main
project) -- it never sees the screen or the keystrokes.

## Please read this before relying on it

This is a genuinely working remote-control app -- real WebRTC screen
share, real mouse/keyboard injection via nut.js, a real consent step and
a real "end session" button the customer controls at all times. But it
was written and syntax-checked in a sandboxed environment with **no
display, no Electron runtime, and no network access to install
dependencies or compile nut.js's native bindings**. That means:

- Every `.js` file here has been checked for syntax errors (`node
  --check`), but none of it has been run. There is no substitute for
  actually installing this, running `npm start`, and doing a real test
  session between two machines before you hand it to a customer.
- The input-injection library is `@nut-tree-fork/nut-js`. The original
  `@nut-tree/nut-js` package was pulled from npm (a first draft of this
  file pointed at it and `npm install` 404'd -- same gotcha other
  people building remote-control tools have hit), and this community
  fork is its actively maintained replacement with the same API. If
  `npm install` ever 404s on it again, check npmjs.com/search?q=nut-tree
  for wherever it's living now and update `package.json`.
- This has not been through any security review. A program that lets a
  stranger control your computer is exactly the kind of software people
  are (rightly) wary of installing. For a real deployment to real
  customers, strongly consider either having this reviewed by someone
  who knows WebRTC/Electron security, or using an established,
  already-audited open-source remote-support tool (MeshCentral and
  RustDesk are two well-known ones) instead of a from-scratch one -- the
  one-time cost of switching is small next to the risk of an
  unreviewed "install this and I can control your PC" tool.
- There's no code signing set up. Windows/macOS will show scary
  "unknown publisher" warnings on an unsigned install, which is normal
  for a first build but something you'll want to fix (a code-signing
  certificate) before sending this to non-technical customers.

## Setup (development)

```bash
cd remote-agent
npm install
npm start
```

This opens the app's window. Enter the Helpdesk server's address (e.g.
`https://helpdesk.yourcompany.co.za`) and the code from a ticket's
"Start remote session" button.

## Building the Windows .msi and macOS .pkg installers

`package.json`'s `"build"` section is already set to produce an **.msi**
on Windows and a **.pkg** on macOS:

```json
"win": { "target": "msi" },
"mac": { "target": "pkg" },
```

```bash
npm install
npm run build
```

**This has to be run on an actual machine of each type** -- and that's
a hard rule of the underlying tools, not a preference:

- **The .msi must be built on Windows** (or a CI runner image of
  Windows, e.g. GitHub Actions' `windows-latest`). `electron-builder`'s
  `msi` target uses Microsoft's WiX Toolset, which needs the real
  Windows installer APIs to assemble the package.
- **The .pkg must be built on macOS** (or macOS CI, e.g. `macos-latest`
  on GitHub Actions). Apple's `pkgbuild`/`productbuild`, which
  `electron-builder` calls for this target, only exist on macOS --
  there is no Linux or Windows version of them, so this can never be
  cross-built from another OS.

I generated and syntax-checked all of this app's source from a Linux
container with no network access to the npm registry and no Windows or
macOS machine available to it, so I could not run either build myself
to hand you finished installer files -- there's no shortcut around the
two platform requirements above.

The fastest path from here, and already set up for you: push this whole
project to a GitHub repo and run the
**`.github/workflows/build-remote-agent.yml`** workflow included at the
project root (Actions tab -> "Build Remote Assist Agent installers" ->
"Run workflow"). It builds the .msi on a real Windows runner and the
.pkg on a real macOS runner -- both GitHub-hosted, so you don't need to
own either kind of machine -- and attaches both finished installers to
that run as downloadable artifacts. Locally, any genuine Windows PC or
Mac with Node.js installed works too (`npm install && npm run build` in
this folder).

Once built, give the installer to customers (a link on your website, or
attached to the ticket-created email) -- they don't need Helpdesk
server access or a login to run it, only the one-time code for each
session. For code signing (strongly recommended -- see the warning
above about "unknown publisher" prompts), see electron-builder's docs
on `win.certificateFile`/`CSC_LINK` for the .msi and
`mac.identity`/notarization for the .pkg.

## Platform notes

- **Windows**: should work out of the box. nut.js's input injection
  uses the Win32 API under the hood.
- **macOS**: the OS will ask the customer to grant **Accessibility**
  access (System Settings -> Privacy & Security -> Accessibility) the
  first time a session tries to move the mouse or type -- this is a
  macOS security gate on *any* app that controls input, not something
  this app can skip. Screen Recording permission is needed too, for the
  screen-share half.
- **Linux**: works under X11. Under Wayland, most compositors block
  synthetic input/screen capture from arbitrary apps for security
  reasons, so this may need Wayland-specific portals (xdg-desktop-portal)
  that aren't wired up here yet -- test on your customers' actual setups
  before relying on this.

## How consent and revocation work

1. The customer launches the app and enters the server address + code.
   Nothing is shared yet.
2. Once the support agent's browser connects on the other end, the
   customer sees an explicit **Allow / Deny** prompt naming what's about
   to happen. Screen sharing only starts on "Allow".
3. While a session is active, a persistent banner in the app's window
   says so, with an **End session now** button that's never hidden,
   covered, or disabled -- the customer can cut the connection
   instantly, for any reason, without needing the agent's cooperation.
4. Mouse/keyboard control only goes through once the WebRTC data channel
   between the two sides is actually open (the banner turns red to make
   this visually obvious) -- up until then the agent can only watch.

## Known gaps worth knowing about

- **Multi-monitor**: this always shares the primary display only. A
  customer with two+ monitors won't be able to show the agent a window
  on their second screen.
- **No audio**: screen only, no system audio or microphone. Talk by
  phone, or use the built-in text chat.
- **No clipboard sync**: can't paste between the agent's and customer's
  machines.
- **One session at a time**: the app doesn't support being connected to
  two support sessions simultaneously.
