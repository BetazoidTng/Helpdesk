-- Helpdesk schema for Microsoft SQL Server.
-- Written to be compatible with SQL Server 2012 and later, same ground
-- rules as the sibling CRM/Auction Site projects:
--   * No "CREATE OR ALTER" (needs 2016 SP1+).
--   * No STRING_AGG, STRING_SPLIT, JSON_VALUE/OPENJSON, CONCAT_WS, or
--     TRIM() (all 2016/2017+). IIF() is fine (2012+). DATETIME2 and
--     SYSUTCDATETIME() are fine (2008+). Filtered indexes are fine (2008+).
--
-- Run automatically by `npm run init-db` (see server/db/init.js), or
-- manually with sqlcmd / SSMS / Azure Data Studio. Safe to re-run: it only
-- creates tables/columns that don't already exist.

IF DB_ID('Helpdesk') IS NULL
BEGIN
    CREATE DATABASE Helpdesk;
END
GO

USE Helpdesk;
GO

-- ===== Users =====
-- Three roles: Admin (manages everything), Agent (works tickets), and
-- Requester (raises tickets -- internal staff or an external customer,
-- distinguished by RequesterType, which is informational/reporting only,
-- not a security boundary). Unlike the CRM, more than one Admin is
-- allowed -- a support desk commonly has more than one person running it.
IF OBJECT_ID('dbo.Users', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.Users (
        Id            INT IDENTITY(1,1) PRIMARY KEY,
        Username      NVARCHAR(50)  NOT NULL UNIQUE,
        Email         NVARCHAR(255) NOT NULL UNIQUE,
        PasswordHash  NVARCHAR(255) NOT NULL,
        FullName      NVARCHAR(150) NOT NULL DEFAULT '',
        Role          NVARCHAR(20)  NOT NULL DEFAULT 'Requester' CHECK (Role IN ('Admin', 'Agent', 'Requester')),
        -- Only meaningful when Role = 'Requester'. NULL for Admin/Agent.
        RequesterType NVARCHAR(20)  NULL CHECK (RequesterType IS NULL OR RequesterType IN ('Internal', 'External')),
        IsActive      BIT           NOT NULL DEFAULT 1,
        CreatedAt     DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
    );
END
GO

-- ===== Categories (shared by Tickets and Knowledge Base articles) =====
IF OBJECT_ID('dbo.Categories', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.Categories (
        Id        INT IDENTITY(1,1) PRIMARY KEY,
        Name      NVARCHAR(100) NOT NULL UNIQUE,
        IsActive  BIT           NOT NULL DEFAULT 1,
        CreatedAt DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
    );
END
GO

-- ===== SLA policy, one row per priority level =====
-- ResponseHours: how long a ticket at this priority may go without a first
-- agent reply before it's considered breached on response.
-- ResolutionHours: how long it may stay unresolved before it's considered
-- breached on resolution -- this is the one the background sweep (see
-- server/lib/slaTimer.js) actually tracks per ticket via
-- Tickets.SLAResolutionDueAt.
IF OBJECT_ID('dbo.SLAPolicies', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.SLAPolicies (
        Priority        NVARCHAR(20) NOT NULL PRIMARY KEY CHECK (Priority IN ('Low', 'Medium', 'High', 'Urgent')),
        ResponseHours   INT          NOT NULL,
        ResolutionHours INT          NOT NULL,
        UpdatedAt       DATETIME2    NOT NULL DEFAULT SYSUTCDATETIME()
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM dbo.SLAPolicies WHERE Priority = 'Urgent')
    INSERT INTO dbo.SLAPolicies (Priority, ResponseHours, ResolutionHours) VALUES ('Urgent', 1, 4);
IF NOT EXISTS (SELECT 1 FROM dbo.SLAPolicies WHERE Priority = 'High')
    INSERT INTO dbo.SLAPolicies (Priority, ResponseHours, ResolutionHours) VALUES ('High', 2, 8);
IF NOT EXISTS (SELECT 1 FROM dbo.SLAPolicies WHERE Priority = 'Medium')
    INSERT INTO dbo.SLAPolicies (Priority, ResponseHours, ResolutionHours) VALUES ('Medium', 4, 24);
IF NOT EXISTS (SELECT 1 FROM dbo.SLAPolicies WHERE Priority = 'Low')
    INSERT INTO dbo.SLAPolicies (Priority, ResponseHours, ResolutionHours) VALUES ('Low', 8, 72);
GO

-- ===== Tickets =====
-- TicketNumber (e.g. "HD-1007") is the human-facing reference used in
-- email subjects for threading -- set by the app right after insert, once
-- it knows the new Id (see server/routes/tickets.js).
IF OBJECT_ID('dbo.Tickets', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.Tickets (
        Id                 INT           IDENTITY(1,1) PRIMARY KEY,
        TicketNumber       NVARCHAR(20)  NOT NULL DEFAULT '',
        Subject            NVARCHAR(300) NOT NULL,
        CategoryId         INT           NULL FOREIGN KEY REFERENCES dbo.Categories(Id),
        Priority           NVARCHAR(20)  NOT NULL DEFAULT 'Medium' CHECK (Priority IN ('Low', 'Medium', 'High', 'Urgent')),
        Status             NVARCHAR(20)  NOT NULL DEFAULT 'New' CHECK (Status IN ('New', 'Open', 'Pending', 'Resolved', 'Closed')),
        -- The requester's own account, when they have one. RequesterName/
        -- RequesterEmail are always filled in regardless (denormalized),
        -- since a ticket raised by email from an address with no account
        -- yet still needs somewhere to send replies.
        RequesterId        INT           NULL FOREIGN KEY REFERENCES dbo.Users(Id),
        RequesterName      NVARCHAR(150) NOT NULL DEFAULT '',
        RequesterEmail     NVARCHAR(255) NOT NULL DEFAULT '',
        AssignedAgentId    INT           NULL FOREIGN KEY REFERENCES dbo.Users(Id),
        Source             NVARCHAR(10)  NOT NULL DEFAULT 'Web' CHECK (Source IN ('Web', 'Email')),
        CreatedAt          DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
        UpdatedAt          DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
        FirstRespondedAt   DATETIME2     NULL,
        ResolvedAt         DATETIME2     NULL,
        ClosedAt           DATETIME2     NULL,
        -- Set from dbo.SLAPolicies at creation/reprioritization time, then
        -- checked by the background sweep -- see server/lib/slaTimer.js.
        SLAResponseDueAt   DATETIME2     NULL,
        SLAResolutionDueAt DATETIME2     NULL,
        SLABreached        BIT           NOT NULL DEFAULT 0,
        -- When the "due soon" warning email was last sent for the
        -- *current* SLAResolutionDueAt -- reset to NULL whenever the
        -- ticket is reassigned, reprioritized, or reopened, so a later SLA
        -- window can warn again. Mirrors the CRM's
        -- CallSheets.EscalationWarningSentAt.
        SLAWarningSentAt   DATETIME2     NULL
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Tickets_Status')
    CREATE INDEX IX_Tickets_Status ON dbo.Tickets(Status);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Tickets_AssignedAgentId')
    CREATE INDEX IX_Tickets_AssignedAgentId ON dbo.Tickets(AssignedAgentId);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Tickets_SLAResolutionDueAt')
    CREATE INDEX IX_Tickets_SLAResolutionDueAt ON dbo.Tickets(Status, SLAResolutionDueAt);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Tickets_RequesterEmail')
    CREATE INDEX IX_Tickets_RequesterEmail ON dbo.Tickets(RequesterEmail);
GO

-- ===== Ticket thread: every message on a ticket, including the first =====
-- The ticket's own "description" is simply its first comment -- there's no
-- separate Description column on Tickets itself. IsInternalNote marks a
-- note only Agents/Admins can see (never shown to the Requester, never
-- emailed out). AuthorId is NULL when the message came from an email
-- address that isn't a registered user -- AuthorName/AuthorEmail still
-- capture who sent it either way.
IF OBJECT_ID('dbo.TicketComments', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.TicketComments (
        Id             INT           IDENTITY(1,1) PRIMARY KEY,
        TicketId       INT           NOT NULL FOREIGN KEY REFERENCES dbo.Tickets(Id),
        AuthorId       INT           NULL FOREIGN KEY REFERENCES dbo.Users(Id),
        AuthorName     NVARCHAR(150) NOT NULL DEFAULT '',
        AuthorEmail    NVARCHAR(255) NOT NULL DEFAULT '',
        Body           NVARCHAR(MAX) NOT NULL,
        IsInternalNote BIT           NOT NULL DEFAULT 0,
        Source         NVARCHAR(10)  NOT NULL DEFAULT 'Web' CHECK (Source IN ('Web', 'Email')),
        -- The inbound email's Message-ID header, when Source = 'Email' --
        -- used to thread a later reply back to this exact message. See
        -- server/lib/emailInbound.js.
        MessageId      NVARCHAR(255) NULL,
        CreatedAt      DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_TicketComments_TicketId')
    CREATE INDEX IX_TicketComments_TicketId ON dbo.TicketComments(TicketId);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_TicketComments_MessageId')
    CREATE INDEX IX_TicketComments_MessageId ON dbo.TicketComments(MessageId);
GO

-- ===== Attachments (always on a specific comment, so an inbound email's
-- attachments land on the comment that email created) =====
IF OBJECT_ID('dbo.Attachments', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.Attachments (
        Id              INT           IDENTITY(1,1) PRIMARY KEY,
        TicketCommentId INT           NOT NULL FOREIGN KEY REFERENCES dbo.TicketComments(Id),
        StoredName      NVARCHAR(255) NOT NULL, -- randomized filename actually on disk
        OriginalName    NVARCHAR(255) NOT NULL, -- filename to show/download as
        MimeType        NVARCHAR(150) NOT NULL DEFAULT '',
        SizeBytes       INT           NOT NULL DEFAULT 0,
        CreatedAt       DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Attachments_TicketCommentId')
    CREATE INDEX IX_Attachments_TicketCommentId ON dbo.Attachments(TicketCommentId);
GO

-- ===== Remote Assist sessions -- one row per "Start remote session"
-- click on a ticket (see server/routes/remoteAssist.js). Code is the
-- short one-time join code given to the customer; the actual video/
-- control stream never touches this database or this server's disk, it's
-- a direct WebRTC peer connection between the customer's agent app and
-- the staff member's browser, with this app only acting as the signaling
-- relay that introduces the two sides to each other. =====
IF OBJECT_ID('dbo.RemoteSessions', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.RemoteSessions (
        Id            INT           IDENTITY(1,1) PRIMARY KEY,
        TicketId      INT           NOT NULL FOREIGN KEY REFERENCES dbo.Tickets(Id),
        Code          NVARCHAR(10)  NOT NULL UNIQUE,
        CreatedById   INT           NOT NULL FOREIGN KEY REFERENCES dbo.Users(Id),
        Status        NVARCHAR(20)  NOT NULL DEFAULT 'Pending' CHECK (Status IN ('Pending', 'Connected', 'Ended')),
        CreatedAt     DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
        ConnectedAt   DATETIME2     NULL,
        EndedAt       DATETIME2     NULL
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_RemoteSessions_TicketId')
    CREATE INDEX IX_RemoteSessions_TicketId ON dbo.RemoteSessions(TicketId);
GO

-- ===== Knowledge base articles =====
IF OBJECT_ID('dbo.KBArticles', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.KBArticles (
        Id          INT           IDENTITY(1,1) PRIMARY KEY,
        Title       NVARCHAR(300) NOT NULL,
        Slug        NVARCHAR(300) NOT NULL UNIQUE,
        Body        NVARCHAR(MAX) NOT NULL DEFAULT '',
        CategoryId  INT           NULL FOREIGN KEY REFERENCES dbo.Categories(Id),
        IsPublished BIT           NOT NULL DEFAULT 0,
        AuthorId    INT           NOT NULL FOREIGN KEY REFERENCES dbo.Users(Id),
        ViewCount   INT           NOT NULL DEFAULT 0,
        CreatedAt   DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
        UpdatedAt   DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
    );
END
GO

-- ===== Login sessions (activity monitoring -- same shape as the CRM) =====
IF OBJECT_ID('dbo.LoginSessions', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.LoginSessions (
        Id           INT           IDENTITY(1,1) PRIMARY KEY,
        UserId       INT           NOT NULL FOREIGN KEY REFERENCES dbo.Users(Id),
        LoginAt      DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
        LogoutAt     DATETIME2     NULL,
        LastSeenAt   DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
        -- Written as "IS NULL OR IN (...)", not "IN ('Logout','Idle',NULL)"
        -- -- SQL's three-valued logic means an IN() list containing NULL
        -- never evaluates to FALSE for any value, so a constraint written
        -- that way would silently accept anything.
        EndReason    NVARCHAR(20)  NULL CHECK (EndReason IS NULL OR EndReason IN ('Logout', 'Idle')),
        IpAddress    NVARCHAR(64)  NOT NULL DEFAULT '',
        UserAgent    NVARCHAR(500) NOT NULL DEFAULT '',
        City         NVARCHAR(100) NULL,
        Country      NVARCHAR(100) NULL
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_LoginSessions_UserId')
    CREATE INDEX IX_LoginSessions_UserId ON dbo.LoginSessions(UserId);
GO

-- ===== Audit log (Admin -> Audit trail) =====
IF OBJECT_ID('dbo.AuditLog', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.AuditLog (
        Id         INT           IDENTITY(1,1) PRIMARY KEY,
        UserId     INT           NULL FOREIGN KEY REFERENCES dbo.Users(Id),
        Action     NVARCHAR(20)  NOT NULL CHECK (Action IN ('Create', 'Update', 'Delete')),
        EntityType NVARCHAR(50)  NOT NULL,
        EntityId   INT           NOT NULL,
        Summary    NVARCHAR(500) NOT NULL DEFAULT '',
        Details    NVARCHAR(MAX) NULL,
        CreatedAt  DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
    );
END
GO

-- ===== App settings an Admin can change from the UI =====
IF OBJECT_ID('dbo.Settings', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.Settings (
        SettingKey   NVARCHAR(100) NOT NULL PRIMARY KEY,
        SettingValue NVARCHAR(500) NOT NULL,
        UpdatedAt    DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
    );
END
GO

-- How many hours before a ticket's SLA resolution timer runs out to send a
-- heads-up warning email to the assigned agent (0 disables the warning).
IF NOT EXISTS (SELECT 1 FROM dbo.Settings WHERE SettingKey = 'SLAWarningHoursBefore')
    INSERT INTO dbo.Settings (SettingKey, SettingValue) VALUES ('SLAWarningHoursBefore', '1');

-- Whether the public /register.html page is open for anyone to create
-- their own Requester account. Off this would mean an Admin has to create
-- every Requester by hand -- on by default since most helpdesks want
-- self-service signup for customers.
IF NOT EXISTS (SELECT 1 FROM dbo.Settings WHERE SettingKey = 'SelfRegistrationEnabled')
    INSERT INTO dbo.Settings (SettingKey, SettingValue) VALUES ('SelfRegistrationEnabled', 'true');

-- Whether a ticket left sitting as Resolved auto-closes itself (emailing
-- the requester to say so) after AutoCloseResolvedHours -- see
-- lib/slaTimer.js's sweepAutoCloseResolvedTickets. On, at 1 hour, by
-- default; an Admin can turn it off or change the lead time from
-- Admin -> Settings any time.
IF NOT EXISTS (SELECT 1 FROM dbo.Settings WHERE SettingKey = 'AutoCloseResolvedEnabled')
    INSERT INTO dbo.Settings (SettingKey, SettingValue) VALUES ('AutoCloseResolvedEnabled', 'true');
IF NOT EXISTS (SELECT 1 FROM dbo.Settings WHERE SettingKey = 'AutoCloseResolvedHours')
    INSERT INTO dbo.Settings (SettingKey, SettingValue) VALUES ('AutoCloseResolvedHours', '1');
GO

-- ===== Starter categories, so the ticket form isn't empty on a fresh
-- install -- an Admin can rename/add/deactivate these from Admin ->
-- Categories any time. =====
IF NOT EXISTS (SELECT 1 FROM dbo.Categories WHERE Name = 'General')
    INSERT INTO dbo.Categories (Name) VALUES ('General');
IF NOT EXISTS (SELECT 1 FROM dbo.Categories WHERE Name = 'Technical Issue')
    INSERT INTO dbo.Categories (Name) VALUES ('Technical Issue');
IF NOT EXISTS (SELECT 1 FROM dbo.Categories WHERE Name = 'Billing')
    INSERT INTO dbo.Categories (Name) VALUES ('Billing');
IF NOT EXISTS (SELECT 1 FROM dbo.Categories WHERE Name = 'Feature Request')
    INSERT INTO dbo.Categories (Name) VALUES ('Feature Request');
GO

-- ===== IT-support starter categories, added alongside the ones above
-- (existing categories are left as-is, since tickets may already use
-- them) -- again, just a starting point an Admin can rename/add/
-- deactivate from Admin -> Categories any time. =====
IF NOT EXISTS (SELECT 1 FROM dbo.Categories WHERE Name = 'Printers')
    INSERT INTO dbo.Categories (Name) VALUES ('Printers');
IF NOT EXISTS (SELECT 1 FROM dbo.Categories WHERE Name = 'Network')
    INSERT INTO dbo.Categories (Name) VALUES ('Network');
IF NOT EXISTS (SELECT 1 FROM dbo.Categories WHERE Name = 'Hardware')
    INSERT INTO dbo.Categories (Name) VALUES ('Hardware');
IF NOT EXISTS (SELECT 1 FROM dbo.Categories WHERE Name = 'Software')
    INSERT INTO dbo.Categories (Name) VALUES ('Software');
IF NOT EXISTS (SELECT 1 FROM dbo.Categories WHERE Name = 'Email & Accounts')
    INSERT INTO dbo.Categories (Name) VALUES ('Email & Accounts');
IF NOT EXISTS (SELECT 1 FROM dbo.Categories WHERE Name = 'Access Requests')
    INSERT INTO dbo.Categories (Name) VALUES ('Access Requests');
GO
