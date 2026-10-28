# Hosting imagine

`scripts/deploy.sh` builds the `Dockerfile` and starts it on the ember box as
https://imagine.emberhub.dev (its header says what the box needs). This page covers
who gets in, and the one piece that lives outside the box: the mailer.

## Who gets in

Only people with an invite (`app/server/access.ts`). Everyone else sees the welcome
page and can join the waitlist.

- **Invite someone** at https://imagine.emberhub.dev/admin: type their email and
  choose *Invite and email them* (or *Just make a link* to send it yourself). A
  waitlist entry has its own *Invite* button.
- They open the link, type the email it was sent to, and that browser stays signed
  in for 90 days. The same link works on their other devices.
- *New link* replaces someone's link (people already signed in stay signed in).
  *Revoke* signs them out everywhere and stops their link.
- The admin page shows each person's projects, every version, and their model calls
  with any errors. Testers only ever see their own work.

From a shell, without the page (this is how the first admin got in):

```bash
ssh deploy@31.220.50.146 docker exec rtdraw-app node app/server/invite.ts someone@example.com
ssh deploy@31.220.50.146 docker exec rtdraw-app node app/server/invite.ts you@emberhub.dev --admin
```

Everything is in the `rtdraw-v2-data` volume: `access/access.json` (people, the
waitlist, and only hashes of links and sessions), `app/owners/<owner>/` (projects),
and `model-calls.jsonl` (every model call, with `who`).

## The mailer

Mail goes through `deploy/mailer.gs`, an Apps Script web app that runs as the
Workspace account, so waitlist sign-ups reach omar@emberhub.dev and invites come from
that address. Until it is set up, the admin page gives you each link to copy and the
waitlist only shows there.

Signed in as omar@emberhub.dev:

1. Open **script.google.com**, make a new project called `imagine-mailer`, and replace
   `Code.gs` with `deploy/mailer.gs`.
2. **Project Settings → Script Properties:** add `SECRET`, with the value in
   `~/imagine-mailer-secret.txt` on Omar's laptop (the box has the same value as
   `MAILER_SECRET` in the box's shared `/srv/emberhub.env`), and `NOTICE_SECRET`, with the value
   in `~/imagine-mailer-notice-secret.txt` (the eval loop's; it sends notices to the admin only).
   Optionally add `SHEET_ID`, the id of a Google Sheet to keep a row per waitlist sign-up and invite.
3. Choose **`authorise`** in the function dropdown, press **Run**, and accept. Its log
   should say `"secretSet": true`, `"noticeSecretSet": true` and a `quotaLeft` of 1500.
4. **Deploy → New deployment → Web app.** Execute as: **Me**. Who has access:
   **Anyone** (every request without the secret is refused).
5. Put the deployment URL, ending in `/exec`, in the box's shared env file and restart:

   ```bash
   ssh deploy@31.220.50.146 'sed -i "s|^MAILER_URL=.*|MAILER_URL=https://script.google.com/macros/s/…/exec|" /srv/emberhub.env && cd /srv/rtdraw && RTDRAW_TAG=$(tail -1 deployed) docker compose up -d --wait'
   ```

A change to the script needs a new version of the deployment (Manage deployments →
edit → New version); the URL stays the same.

The eval loop mails the admin through the same script (its `notice` action) when it
stops for a reason that's the owner's, or holds a decision for them: harness words and
ids only, never a tester's. It reads the URL and `NOTICE_SECRET`'s value (as `MAILER_SECRET`) from
`~/.config/rt-eval/notify.env` on the PGX (mode 600; `evals/loop/notify.ts`), so the PGX holds no
secret that can mail anyone else. To put it there without it passing through a terminal:

```bash
ssh "$RT_PGX" 'f=~/.config/rt-eval/notify.env; s=$(cat); sed -i "s|^MAILER_SECRET=.*|MAILER_SECRET=$s|" "$f"' < ~/imagine-mailer-notice-secret.txt
```
