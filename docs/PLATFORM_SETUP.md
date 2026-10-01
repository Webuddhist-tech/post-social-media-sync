# Connecting each platform

Every platform makes you register a free "developer app" before software can post for you. You do this once per
platform, put the keys in `.env`, restart the server, and then click **Connect** in the dashboard
(**Accounts** tab).

The **Setup** tab in the dashboard shows the exact *redirect URI* to paste into each developer console. It is always:

```
<PUBLIC_BASE_URL>/oauth/<connector>/callback
```

| Platform | Connector | `.env` keys | Can post right away? |
| --- | --- | --- | --- |
| Facebook Pages + Instagram | `meta` | `META_APP_ID`, `META_APP_SECRET` | Yes for accounts with a role on your Meta app. Other people need Meta App Review. |
| TikTok | `tiktok` | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | Only **private** ("Only me") posts until TikTok audits your app. |
| YouTube | `google` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Uploads are **private** until Google audits your API project. |
| LinkedIn | `linkedin` | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | Yes, for your personal profile. Company Pages need extra approval. |
| Threads | `threads` | `THREADS_APP_ID`, `THREADS_APP_SECRET` | Yes for Threads testers on your app. |
| X (Twitter) | `x` | `X_CLIENT_ID`, `X_CLIENT_SECRET` | Yes, but the X API charges for posting. |
| Bluesky | – | none | Yes, with an app password. |

> **Tip:** start with Bluesky. It needs no developer app, so you can check the whole flow in two minutes.

Developer consoles get redesigned often, so menu names below may differ slightly. The values you need (IDs,
secrets, redirect URI, permissions) stay the same.

---

## Before you start: a public HTTPS address

Most platforms only accept HTTPS redirect URIs (`http://localhost` is allowed by Google and X, and by Meta in
development mode), and **Instagram photos and all Threads media are downloaded by the platform from your
server**. So it's easiest to give the server a public HTTPS address first and put it in `PUBLIC_BASE_URL`:

- **Deploy it** on a small VPS with a domain (see the README for a Docker + Caddy example), or
- **Run a tunnel** from your computer:
  ```bash
  cloudflared tunnel --url http://localhost:3000     # prints https://<random>.trycloudflare.com
  # or: ngrok http 3000
  ```
  Quick tunnels get a new random address every time they start. If the address changes, update
  `PUBLIC_BASE_URL` *and* the redirect URIs in every developer console. A named Cloudflare tunnel or a
  reserved ngrok domain keeps it stable.

---

## Facebook Pages and Instagram (one Meta app)

What you need:
- A **Facebook Page** you manage (Meta doesn't allow apps to post to personal Facebook profiles).
- For Instagram: an Instagram **Professional account** (Business or Creator) that is **linked to that Facebook
  Page** (Instagram app → Settings → Account type and tools; then in the Page's settings, Linked accounts → Instagram).

Steps:
1. Go to <https://developers.facebook.com/apps> and **Create app**. Pick the use cases for managing a Page and
   Instagram content (or the "Business" app type if you're offered app types).
2. Add **Facebook Login for Business** (or Facebook Login). In its settings, add the redirect URI shown in the
   Setup tab (`…/oauth/meta/callback`) under **Valid OAuth Redirect URIs**.
3. Make sure the app can request these permissions:
   `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `business_management`,
   `instagram_basic`, `instagram_content_publish`.
   - If your app uses **Facebook Login for Business configurations**, create a configuration (user access token)
     with those permissions and put its ID in `META_LOGIN_CONFIG_ID`.
4. **App settings → Basic**: copy the App ID and App secret into `META_APP_ID` / `META_APP_SECRET`.
5. Restart the server, open **Accounts → Connect Facebook & Instagram**, and in Meta's dialog **select all the
   Pages and Instagram accounts** you want to use. Each Page and each linked Instagram account appears as its own
   account in Post Sync.

Good to know:
- While the app is in development mode only people with a role on the app (admin, developer, tester) can connect.
  That's fine for your own accounts. To let others connect, submit the permissions for **App Review** (Meta also
  asks for business verification).
- Facebook Page tokens obtained this way don't expire. If you change your Facebook password or remove the app,
  just reconnect.
- **Instagram:** photos must be JPEG with an aspect ratio between 4:5 and 1.91:1 (Post Sync converts PNG/WebP to
  JPEG automatically; crop images that are too tall/wide). Videos are published as **Reels** and uploaded
  directly, so they work without a public URL; photos need `PUBLIC_BASE_URL` to be reachable from the internet.
  Up to 10 items become a carousel. Instagram limits API publishing per account per 24 hours.
- **Facebook:** text, links, up to 10 photos, or one video. In the post settings you can choose to publish a
  video as a **Reel** instead of a regular video post.

## TikTok

1. Go to <https://developers.tiktok.com/apps> and create an app.
2. Add the products **Login Kit** and **Content Posting API**. In the Content Posting API settings, turn on
   **Direct Post**.
3. In Login Kit, add the redirect URI from the Setup tab (`…/oauth/tiktok/callback`). TikTok requires HTTPS.
4. Make sure the scopes `user.info.basic`, `video.publish` and `video.upload` are enabled.
5. Copy the **Client key** and **Client secret** into `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET`.
6. Restart and connect TikTok from the Accounts tab.

Good to know:
- **Until TikTok audits your app, every direct post is private ("Only me")** and only a few accounts can connect.
  Pick "Only me" in the TikTok settings of a post, or choose **Send to TikTok inbox**, which puts the video in
  your TikTok inbox so you can finish and publish it from the app. To post publicly, submit the app for TikTok's
  audit. TikTok reviews the posting screen against its content sharing guidelines (privacy choice, interaction
  settings, commercial content disclosure, and more). Post Sync's composer has these settings, but TikTok may
  still ask for changes, such as having no default privacy level.
- If your app only has inbox-upload access, set `TIKTOK_SCOPES=user.info.basic,video.upload` and always use
  "Send to TikTok inbox".
- TikTok posts need exactly one video. The allowed length depends on the account (Post Sync checks it).
- TikTok logins last a year; Post Sync refreshes the short-lived access token automatically.

## YouTube

1. Open <https://console.cloud.google.com/>, create a project.
2. **APIs & Services → Library**: enable **YouTube Data API v3**.
3. **OAuth consent screen** (Google Auth Platform): user type *External*, fill in the app name and your email,
   add the scopes `.../auth/youtube.upload` and `.../auth/youtube.readonly`, and add your Google account as a
   **test user**.
4. **Credentials → Create credentials → OAuth client ID** → *Web application*. Add the redirect URI from the
   Setup tab (`…/oauth/google/callback`).
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
3. **Auth** tab: add the redirect URI from the Setup tab (`…/oauth/linkedin/callback`) under *Authorized redirect
   URLs*, then copy the Client ID and Client Secret into `.env`.
4. Restart and connect LinkedIn.

Good to know:
- To post as a **Company Page**, your app also needs the **Community Management API** product (LinkedIn reviews
  these requests). Once approved, set `LINKEDIN_ORGANIZATIONS=true` and reconnect: every Page you administer
  shows up as its own account.
- LinkedIn logins last about 60 days. Unless your app has been granted refresh tokens, reconnect when the
  dashboard says so.
- Videos must be MP4, 3 seconds to 30 minutes, under 500 MB. Up to 20 images per post.
- LinkedIn retires API versions after about a year. Post Sync picks the newest active version automatically;
  set `LINKEDIN_VERSION=YYYYMM` only if you want to pin one.

## Threads

1. At <https://developers.facebook.com/apps>, create an app with the **Threads API** use case.
2. Add the permissions `threads_basic` and `threads_content_publish`.
3. In the Threads use case settings, add the redirect URI from the Setup tab (`…/oauth/threads/callback`) as a
   callback URL (Meta also asks for uninstall/delete callback URLs; any page on your site is fine for personal
   use).
4. Under **App roles**, add your Threads account as a **Threads Tester**, then accept the invite in the Threads
   app (Settings → Account → Website permissions → Invites).
5. Copy the **Threads app ID** and **Threads app secret** (they differ from the main Meta app ID) into
   `THREADS_APP_ID` / `THREADS_APP_SECRET`, restart, and connect.

Good to know: Threads downloads photos and videos from `PUBLIC_BASE_URL`, so it must be public. Text posts work
without that. Posts are limited to 500 characters; up to 20 items become a carousel. Post Sync refreshes the
60-day token automatically.

## X (Twitter)

1. In the developer portal (<https://developer.x.com>), create a project and an app.
2. **User authentication settings**: enable **OAuth 2.0**, app type *Web App, Automated App or Bot*, permissions
   **Read and write**. Add the callback URI from the Setup tab (`…/oauth/x/callback`) and your website URL.
3. **Keys and tokens**: copy the OAuth 2.0 **Client ID** and **Client Secret** into `X_CLIENT_ID` /
   `X_CLIENT_SECRET`, restart, and connect.

Good to know: posting through the X API is a paid feature; check the current plans/pricing in the developer
portal. Up to 4 photos or 1 video per post. If your account has X Premium, tick "Account has X Premium" in the
post settings to allow long posts.

## Bluesky

No developer app needed.

1. In Bluesky: **Settings → Privacy and security → App passwords → Add app password**.
2. In Post Sync: **Accounts → Bluesky**, enter your handle (e.g. `you.bsky.social`) and the app password.
   If your account lives on a self-hosted server, enter its address under *Server*.

Good to know: posts are limited to 300 characters. Up to 4 images (Post Sync compresses them under Bluesky's
1 MB limit) or one video (up to 3 minutes / 100 MB; Bluesky requires a verified email for video). Links,
#hashtags and @mentions become clickable automatically.
