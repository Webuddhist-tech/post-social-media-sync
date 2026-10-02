# Connecting each platform

Every platform makes you register a free "developer app" before software can post for you. You do this once per
platform, give Post Sync the app's keys, and then connect accounts:

- **Post Sync server (dashboard or headless):** put the keys in `.env`, restart the server, and click **Connect**
  in the dashboard (**Accounts** tab), or call `POST /api/connect/<connector>` from your backend.
- **The package in your own backend:** pass the keys in the `platforms` option of `createPostSync()` and use your
  own "Connect" buttons (see [PLUGIN.md](PLUGIN.md#oauth-redirect-uris)).

The steps below say ".env" and "the dashboard"; the table shows the matching package option in parentheses.

## Redirect URIs

Each developer console asks for a *redirect URI* (also called callback URL). It must match exactly:

| You run | Redirect URI |
| --- | --- |
| The Post Sync server | `<PUBLIC_BASE_URL>/api/oauth/<connector>/callback`, e.g. `https://posts.example.com/api/oauth/meta/callback` |
| The package | `<publicUrl>/oauth/<connector>/callback`, e.g. `https://app.example.com/social/oauth/meta/callback` |

The dashboard's **Setup** tab shows the exact values. With the package, `sync.redirectUri("meta")` returns it, and
`(await sync.describe()).connectors[].redirectUri` lists all of them.

> **Upgrading from 0.1:** the server's redirect URIs used to be `<PUBLIC_BASE_URL>/oauth/<connector>/callback`
> (without `/api`). Update them in every developer console.

| Platform | Connector | `.env` keys (package option) | Can post right away? |
| --- | --- | --- | --- |
| Facebook Pages + Instagram | `meta` | `META_APP_ID`, `META_APP_SECRET` (`platforms.meta: { appId, appSecret }`) | Yes for accounts with a role on your Meta app. Other people need Meta App Review. |
| TikTok | `tiktok` | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` (`platforms.tiktok: { clientKey, clientSecret }`) | Only **private** ("Only me") posts until TikTok audits your app. |
| YouTube | `google` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (`platforms.google: { clientId, clientSecret }`) | Uploads are **private** until Google audits your API project. |
| LinkedIn | `linkedin` | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` (`platforms.linkedin: { clientId, clientSecret }`) | Yes, for your personal profile. Company Pages need extra approval. |
| Threads | `threads` | `THREADS_APP_ID`, `THREADS_APP_SECRET` (`platforms.threads: { appId, appSecret }`) | Yes for Threads testers on your app. |
| X (Twitter) | `x` | `X_CLIENT_ID`, `X_CLIENT_SECRET` (`platforms.x: { clientId, clientSecret }`) | Yes, but the X API charges for posting. |
| Bluesky | `bluesky` | none | Yes, with an app password. |

> **Tip:** start with Bluesky. It needs no developer app, so you can check the whole flow in two minutes.
>
> After connecting any account, click **Test** next to it on the Accounts tab (package: `sync.accounts.check()`,
> or `POST /accounts/:id/check`). It checks that the login works (and, for TikTok, shows which privacy options the
> account has) without posting anything.

Developer consoles get redesigned often, so menu names below may differ slightly. The values you need (IDs,
secrets, redirect URI, permissions) stay the same.

---

## Before you start: a public HTTPS address

Most platforms only accept HTTPS redirect URIs (`http://localhost` is allowed by Google and X, and by Meta in
development mode), and **Instagram photos and all Threads media are downloaded by the platform from your
server**. So it's easiest to give the server a public HTTPS address first and put it in `PUBLIC_BASE_URL` (or, with
the package, use it in `publicUrl`):

- **Deploy it** on a small VPS with a domain (see the README for a Docker + Caddy example), or
- **Run a tunnel** from your computer:
  ```bash
  cloudflared tunnel --url http://localhost:3000     # prints https://<random>.trycloudflare.com
  # or: ngrok http 3000
  ```
  Quick tunnels get a new random address every time they start. If the address changes, update
  `PUBLIC_BASE_URL` (or `publicUrl`) *and* the redirect URIs in every developer console. A named Cloudflare
  tunnel or a reserved ngrok domain keeps it stable.

---

## Facebook Pages and Instagram (one Meta app)

What you need:
- A **Facebook Page** you manage (Meta doesn't allow apps to post to personal Facebook profiles).
- For Instagram: an Instagram **Professional account** (Business or Creator) that is **linked to that Facebook
  Page** (Instagram app → Settings → Account type and tools; then in the Page's settings, Linked accounts → Instagram).

Steps:
1. Go to <https://developers.facebook.com/apps> and **Create app**. Pick the use cases for managing a Page and
   Instagram content (or the "Business" app type if you're offered app types).
2. Add **Facebook Login for Business** (or Facebook Login). In its settings, add your
   [redirect URI](#redirect-uris) (`…/oauth/meta/callback`) under **Valid OAuth Redirect URIs**.
3. Make sure the app can request these permissions:
   `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `business_management`,
   `instagram_basic`, `instagram_content_publish`.
   - If your app uses **Facebook Login for Business configurations**, create a configuration (user access token)
     with those permissions and put its ID in `META_LOGIN_CONFIG_ID` (package: `platforms.meta.loginConfigId`).
4. **App settings → Basic**: copy the App ID and App secret into `META_APP_ID` / `META_APP_SECRET`.
5. Restart the server, open **Accounts → Connect Facebook & Instagram**, and in Meta's dialog **select all the
   Pages and Instagram accounts** you want to use. Each Page and each linked Instagram account appears as its own
   account in Post Sync.

Good to know:
- If your role on the Page comes from **Business Manager** (common for agencies), Meta also requires the
  `ads_read` permission to publish to Instagram. Add it to the app, set `META_EXTRA_SCOPES=ads_read` (package:
  `platforms.meta.extraScopes: ["ads_read"]`), or add it to your Login for Business configuration, and reconnect.
- Post Sync only connects Pages your role can create content on, and skips Instagram accounts if you declined the
  Instagram permissions in Meta's dialog.
- While the app is in development mode only people with a role on the app (admin, developer, tester) can connect.
  That's fine for your own accounts. To let others connect, submit the permissions for **App Review** (Meta also
  asks for business verification).
- Facebook Page tokens obtained this way don't expire. If you change your Facebook password or remove the app,
  just reconnect.
- **Instagram:** photos must be JPEG with an aspect ratio between 4:5 and 1.91:1 (Post Sync converts PNG/WebP to
  JPEG automatically; crop images that are too tall/wide). Videos are published as **Reels** (MP4/MOV, 3 seconds
  to 15 minutes, up to 300 MB) and uploaded directly, so they work without a public URL; photos need
  `PUBLIC_BASE_URL` (or `publicUrl`) to be reachable from the internet. Up to 10 items become a carousel (videos
  in a carousel: 3–60 seconds). Captions: up to 2,200 characters, 30 hashtags and 20 @mentions. Instagram limits
  API publishing per account per 24 hours.
- **Facebook:** text, links, up to 10 photos (photos over 4 MB are shrunk automatically), or one video (up to
  1 GB / 20 minutes). In the post settings you can publish a video as a **Reel** instead (vertical, 3–90 seconds).

## TikTok

1. Go to <https://developers.tiktok.com/apps> and create an app.
2. Add the products **Login Kit** and **Content Posting API**. In the Content Posting API settings, turn on
   **Direct Post**.
3. In Login Kit, add your [redirect URI](#redirect-uris) (`…/oauth/tiktok/callback`). TikTok requires HTTPS.
4. Make sure the scopes `user.info.basic`, `video.publish` and `video.upload` are enabled.
5. Copy the **Client key** and **Client secret** into `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET`.
6. Restart and connect TikTok from the Accounts tab.

Good to know:
- **Until TikTok audits your app, every direct post is private ("Only me")**, the TikTok account itself must be
  set to **Private** in the TikTok app, and at most 5 accounts can post per day.
  Pick "Only me" in the TikTok settings of a post, or choose **Send to TikTok inbox**, which puts the video in
  your TikTok inbox so you can finish and publish it from the app. To post publicly, submit the app for TikTok's
  audit. TikTok reviews the posting screen against its content sharing guidelines (privacy choice, interaction
  settings, commercial content disclosure, and more). Following those rules, Post Sync makes you pick the privacy
  level for every TikTok post (there is no default) and leaves comments, Duet and Stitch off unless you turn them
  on.
- If your app only has inbox-upload access, set `TIKTOK_SCOPES=user.info.basic,video.upload` (package:
  `platforms.tiktok.scopes`) and always use "Send to TikTok inbox".
- TikTok posts need exactly one video. The allowed length depends on the account (Post Sync checks it).
- TikTok logins last a year; Post Sync refreshes the short-lived access token automatically.

## YouTube

1. Open <https://console.cloud.google.com/>, create a project.
2. **APIs & Services → Library**: enable **YouTube Data API v3**.
3. **OAuth consent screen** (Google Auth Platform): user type *External*, fill in the app name and your email,
   add the scopes `.../auth/youtube.upload` and `.../auth/youtube.readonly`, and add your Google account as a
   **test user**.
4. **Credentials → Create credentials → OAuth client ID** → *Web application*. Add your
   [redirect URI](#redirect-uris) (`…/oauth/google/callback`) under *Authorized redirect URIs*.
5. Copy the client ID and secret into `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, restart, and connect YouTube.
   Pick the channel (or Brand Account) you want when Google asks.

Good to know:
- **Videos uploaded by an unverified API project are locked to private.** To publish publicly, request an audit
  through Google's YouTube API Services audit/quota form. Post Sync tells you when YouTube overrode the
  visibility.
- While the consent screen is in **Testing**, Google expires the login after **7 days**; reconnect when the
  dashboard asks, or move the consent screen to *In production* (Google may require verification for the upload
  scope).
- Uploads use API quota (default 10,000 units/day per project). Check *APIs & Services → Quotas* if uploads fail
  with a quota error.
- Vertical videos up to 3 minutes are shown as **Shorts** automatically.

## LinkedIn

1. Go to <https://www.linkedin.com/developers/apps> and create an app (LinkedIn asks you to associate it with a
   LinkedIn Page; you can create a simple one).
2. **Products** tab: add **Sign In with LinkedIn using OpenID Connect** and **Share on LinkedIn**.
3. **Auth** tab: add your [redirect URI](#redirect-uris) (`…/oauth/linkedin/callback`) under *Authorized redirect
   URLs*, then copy the Client ID and Client Secret into `.env`.
4. Restart and connect LinkedIn.

Good to know:
- To post as a **Company Page**, your app also needs the **Community Management API** product (LinkedIn reviews
  these requests). Once approved, set `LINKEDIN_ORGANIZATIONS=true` (package: `platforms.linkedin.organizations:
  true`) and reconnect: every Page you administer shows up as its own account.
- LinkedIn logins last about 60 days. Unless your app has been granted refresh tokens, reconnect when the
  dashboard says so.
- Videos must be MP4, 3 seconds to 30 minutes, under 500 MB. Up to 20 images per post.
- LinkedIn retires API versions after about a year. Post Sync picks the newest active version automatically;
  set `LINKEDIN_VERSION=YYYYMM` (package: `platforms.linkedin.version`) only if you want to pin one.

## Threads

1. At <https://developers.facebook.com/apps>, create an app with the **Threads API** use case.
2. Add the permissions `threads_basic` and `threads_content_publish`.
3. In the Threads use case settings, add your [redirect URI](#redirect-uris) (`…/oauth/threads/callback`) as a
   callback URL (Meta also asks for uninstall/delete callback URLs; any page on your site is fine for personal
   use).
4. Under **App roles**, add your Threads account as a **Threads Tester**, then accept the invite in the Threads
   app (Settings → Account → Website permissions → Invites).
5. Copy the **Threads app ID** and **Threads app secret** (they differ from the main Meta app ID) into
   `THREADS_APP_ID` / `THREADS_APP_SECRET`, restart, and connect.

Good to know: Threads downloads photos and videos from `PUBLIC_BASE_URL` (or `publicUrl`), so it must be public.
Text posts work without that. Posts are limited to 500 characters (each emoji counts as several) and at most 5
links; up to 20 items become a carousel. Videos: MP4/MOV, up to 1 GB and 5 minutes. Post Sync refreshes the 60-day
token automatically.

## X (Twitter)

1. In the developer portal (<https://developer.x.com>), create a project and an app.
2. **User authentication settings**: enable **OAuth 2.0**, app type *Web App, Automated App or Bot*, permissions
   **Read and write**. Add your [redirect URI](#redirect-uris) (`…/oauth/x/callback`) as the callback URI, and your
   website URL.
3. **Keys and tokens**: copy the OAuth 2.0 **Client ID** and **Client Secret** into `X_CLIENT_ID` /
   `X_CLIENT_SECRET`, restart, and connect.

Good to know: posting through the X API is a paid feature; check the current plans/pricing in the developer
portal. Up to 4 photos (shrunk to 5 MB if bigger) or 1 video (up to 512 MB and 2:20) per post. If your account
has X Premium, tick "Account has X Premium" in the post settings to allow long posts and longer videos.

## Bluesky

No developer app needed.

1. In Bluesky: **Settings → Privacy and security → App passwords → Add app password**.
2. In Post Sync: **Accounts → Bluesky**, enter your handle (e.g. `you.bsky.social`) and the app password.
   If your account lives on a self-hosted server, enter its address under *Server*. (With the package, your form
   sends `{ identifier, appPassword, service? }` to `POST /connect/bluesky/credentials`; `describe()` lists these
   fields as `credentialFields`.)

Good to know: posts are limited to 300 characters. Up to 4 images (Post Sync compresses anything over Bluesky's
2 MB limit) or one video (up to 10 minutes / 300 MB; Bluesky requires a verified email for video). Links,
#hashtags and @mentions become clickable automatically.
