# Helpdesk

A ticketing/helpdesk system for both internal staff and external customers:
ticket queue with assignment, SLA timers and escalation, two-way
email-to-ticket, a knowledge base, and a reporting dashboard. Node.js +
Express + plain HTML/CSS/JS, backed by Microsoft SQL Server.

## Roles

- **Admin** -- everything an Agent can do, plus user/category/SLA-policy
  management, settings, and the audit log. Unlike some of this app's
  sibling projects, Helpdesk allows more than one Admin.
- **Agent** -- works the ticket queue: triage, reply, assign, resolve.
- **Requester** -- raises tickets and tracks their own. Can self-register
  (gated by an Admin-toggleable setting) or be created by an Admin.
  `RequesterType` (Internal/External) is just a reporting tag, not a
  security boundary -- both see exactly the same portal.

## Local development setup

Requires [Node.js](https://nodejs.org) (LTS) and
[Docker Desktop](https://www.docker.com/products/docker-desktop) (for a
local SQL Server container).

```
./scripts/setup-dev.sh
npm start
```

Then open http://localhost:3200. On a brand-new database you'll land on
`/setup.html` to create the first Admin account. Everyone else is created
either by that Admin (Admin -> Users) or signs up at `/register.html`, if
self-registration is turned on (Admin -> Settings; on by default).

`npm run dev` restarts the server automatically when a file changes.

## Deploying to a Windows Server / SQL Server box

```
.\scripts\setup-windows-server.ps1
```

This installs dependencies, walks you through `.env`, builds the database
(safe to re-run), and registers the app under `pm2` so it survives a
reboot. Re-run the script any time you need to pick up new `.env` settings
or restart the service.

The schema in `db/schema.sql` is written in SQL Server 2012-compatible
syntax (no `CREATE OR ALTER`, no `STRING_AGG`/`STRING_SPLIT`/JSON
functions, filtered unique indexes instead of partial `CHECK`s), so it
runs unchanged against an old on-prem instance or a brand-new one.

## HTTPS

The app can serve HTTPS directly, side by side with its normal HTTP port
-- no IIS or reverse proxy required. Leave `SSL_CERT_PATH`/`SSL_KEY_PATH`
unset (the default) and it just runs on HTTP, same as always.

To turn it on, get a certificate for your domain -- for a real one on a
Windows Server box, [win-acme](https://www.win-acme.com/) is a solid free
option (Let's Encrypt). For local testing, a self-signed certificate works
fine:

```
openssl req -x509 -nodes -newkey rsa:2048 -days 365 -keyout localhost-key.pem -out localhost-cert.pem -subj "/CN=localhost"
```

Then set in `.env`:

```
SSL_CERT_PATH=C:\certs\localhost-cert.pem
SSL_KEY_PATH=C:\certs\localhost-key.pem
HTTPS_PORT=3443
```

`SSL_CA_PATH` is optional, for an intermediate certificate chain if your
certificate authority needs one. `COOKIE_SECURE` is independent of all
this -- set it to `true` once you're actually serving over HTTPS, whatever
route got you there.

## Outbound email notifications

Set the `SMTP_*` block in `.env` (works with any SMTP provider -- Office
365, Gmail with an app password, SendGrid, etc.) and the app emails
requesters and agents on ticket creation, replies, assignment, SLA
due-soon warnings, SLA breaches, and resolution. Leave `SMTP_HOST` unset
and the app simply doesn't send mail -- every other feature still works.

## Email-to-ticket (inbound)

Set the `IMAP_*` block in `.env` and the app polls that mailbox every
`IMAP_POLL_SECONDS` (default 60), turning:

- a new email into a new ticket (the sender becomes the requester; if
  their address matches an existing user, the ticket links to that
  account), and
- a reply to one of this app's own notification emails -- it keeps the
  `[HD-123]` ticket tag in the subject when a mail client replies -- into
  a reply on that ticket, reopening it if it was Resolved/Closed.

Usually `SMTP_USER`/`SMTP_PASSWORD` and `IMAP_USER`/`IMAP_PASSWORD` are the
same mailbox, so a reply to a notification email lands right back in the
inbox this polls. Leave `IMAP_HOST` unset and inbound email-to-ticket is
simply turned off -- tickets can still be raised through the portal.

## SLA timers and escalation

Each priority (Low/Medium/High/Urgent) has its own response/resolution
target in Admin -> SLA Policies. A background sweep (every 5 minutes)
flags a ticket as breached once its resolution due-date passes, and sends
the assigned agent a warning a configurable number of hours before that
(Admin -> Settings -> "Warn the agent this many hours before an SLA is
due"). Changing a ticket's priority recomputes its due-dates from when it
was created.

The same sweep also auto-closes a ticket that's been sitting as Resolved
for a while, emailing the requester to say it's been resolved and closed
(Admin -> Settings -> "Automatically close a ticket after it's been
Resolved for a while" / "Hours after resolving before it auto-closes" --
on, at 1 hour, by default). A reply from the requester after that --
whether through the portal or by email, quoting the ticket's `[HD-123]`
tag in the subject -- reopens it exactly the same way a reply to a
Resolved ticket would, so closing never forecloses on a ticket that
genuinely wasn't fixed.

## Reports

Admin/Agent -> Reports: headline counts (open, resolved this week,
currently breached, created this week, average resolution time), plus
Chart.js graphs for the 30-day created-vs-resolved trend, breakdowns by
status/priority/category, and agent workload.

## Attachments

Files attach to a specific message in a ticket's thread -- the initial
description or any reply -- whether uploaded through the portal/queue, an
email attachment, or a screenshot pasted straight into the description/reply
box with Ctrl+V (Cmd+V on Mac) -- the browser's clipboard API treats a
pasted image the same as a picked file, and it's merged into the same
upload before the ticket/reply is submitted. An inline screenshot pasted
into an email's body (not just a traditional attachment) also comes
through, since mailparser reports those the same way as regular
attachments. Up to 5 files per message, 20MB each (file picker + pasted
screenshots combined), no type restriction. Image attachments show as a
small inline thumbnail in the thread; anything else shows as a link.
A Requester can only see attachments on their own tickets, and never on an
internal note.

On a ticket's page, the "Upload screenshot" button next to the reply box
skips typing a note and hitting Send entirely: clicking it tries to read an
image straight off the clipboard (so "copy a screenshot, click the button"
needs no file dialog at all), and falls back to the ordinary file picker
when the browser's Clipboard API isn't available, isn't permitted, or
there's no image on the clipboard right now. Either way it posts
immediately as its own minimal reply ("Screenshot attached.").

Every attachment -- however it arrived -- has a Delete link next to it.
Staff can delete any attachment; a Requester can only delete one they
uploaded themselves, and never one on an internal note or one that arrived
by email (those have no uploader to match against, so only Staff can
remove them). Deleting removes both the database row and the file on disk.

## Remote Assist

Lets an Admin/Agent see -- and, once the customer allows it, control --
a customer's screen straight from a ticket. Click **Start remote
session** on a ticket's page; it gives you a short one-time code and
opens a viewer. Give the customer that code and have them run the
**Remote Assist Agent** desktop app (see `remote-agent/` -- it's a
separate small program the customer installs once, not a web page,
since a browser alone can't let anyone control another computer's mouse
and keyboard). They type in your Helpdesk server's address and the code,
and get an explicit **Allow / Deny** prompt before anything is shared.

The video and control stream are a direct peer-to-peer WebRTC connection
between the customer's agent app and the staff member's browser --
Helpdesk's server (`server/lib/remoteAssistSignaling.js`, riding on the
same HTTP/HTTPS port as everything else) only relays the initial
handshake to introduce the two sides, and never sees the screen or
keystrokes. The customer always has a visible, persistent "end session"
control of their own, independent of anything the agent does.

**Before using this with real customers**, read
`remote-agent/README.md` in full -- it was built and syntax-checked in
an environment with no display or Electron runtime to actually run it
in, so it needs a real install-and-test pass (and ideally a security
review, given what this class of software does) before you rely on it.

To get an installable Windows **.msi** and macOS **.pkg** for the agent
app, push this project to a repo and run
`.github/workflows/build-remote-agent.yml` (Actions tab -> "Run
workflow") -- it builds each on a real Windows/macOS GitHub runner and
attaches both as downloadable artifacts. Neither installer format can
be built on Linux, or cross-built from the other OS, which is why this
isn't something done directly here.

## Knowledge base

Published articles are readable by anyone, including a visitor who isn't
logged in yet. Only an Admin or Agent can write or publish one (Admin and
Agent both see Knowledge Base in the nav with a "+ New Article" option).

## Project structure

```
server/
  db/            connection pool, schema init, create-admin CLI
  lib/           password hashing, mailer, IMAP polling, SLA sweep,
                 ticket email templates, settings, audit log, HTTPS
                 server, Remote Assist's WebSocket signaling relay
  middleware/    auth/role guards
  routes/        setup, auth, tickets, categories, kb, admin, reports,
                 remote-assist
public/
  css/js/        shared styles and nav/session handling
  *.html         one page per screen (login, portal, queue, ticket, kb,
                 reports, admin, remote-assist)
db/
  schema.sql     SQL Server 2012-compatible schema (safe to re-run)
scripts/
  setup-dev.sh                 local Docker + npm + db setup
  setup-windows-server.ps1     production server setup (pm2 + firewall)
remote-agent/
  (separate Electron app the customer installs -- see its own README)
```
