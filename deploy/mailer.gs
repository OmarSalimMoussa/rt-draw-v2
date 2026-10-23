/**
 * imagine's mailer: the hosted app (app/server/mailer.ts) POSTs here, and this sends the mail as
 * the Workspace account, so it comes from omar@emberhub.dev with no mail service or password in
 * between. Adapted from the Ember site's call request form (ember-site, web/apps-script).
 *
 * Two kinds of mail:
 *   waitlist  someone asked to try imagine: mailed to ADMIN (and a row in the sheet, if there is one)
 *   invite    the admin invited someone: mailed to them, with their link
 *
 * Only the imagine server may call it: every request carries SECRET, which lives in Script
 * Properties here and in MAILER_SECRET on the server. Without it, anyone could mail anyone as you.
 * An invite's link must also be one of imagine's own.
 *
 * This file isn't part of any build. It is pasted into a standalone Apps Script project and deployed
 * as a web app; deploy/README.md says how.
 */

var ADMIN = 'omar@emberhub.dev';
var SITE = 'https://imagine.emberhub.dev/join/';

function prop(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}

/** Run once from the editor after pasting: it asks for the permissions and logs who it sends as. */
function authorise() {
  var report = {
    account: Session.getEffectiveUser().getEmail(),
    quotaLeft: MailApp.getRemainingDailyQuota(),
    secretSet: prop('SECRET').length >= 32,
    sheet: prop('SHEET_ID') ? SpreadsheetApp.openById(prop('SHEET_ID')).getName() : 'no sheet (optional)',
  };
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

function doPost(e) {
  try {
    var f = JSON.parse(e.postData.contents);
    var secret = prop('SECRET');
    if (!secret || secret.length < 32 || f.secret !== secret) return json({ ok: false, error: 'not allowed' });
    var email = String(f.email || '').trim();
    if (!/^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/.test(email)) return json({ ok: false, error: 'bad email' });

    if (f.action === 'waitlist') {
      var note = String(f.note || '').trim().slice(0, 1000);
      row(['waitlist', email, note]);
      var ref = 'Ref ' + Utilities.getUuid().slice(0, 8).toUpperCase();
      GmailApp.sendEmail(ADMIN, 'imagine waitlist: ' + email, [
        email + ' wants to try imagine.',
        '',
        note ? 'Their note: ' + note : 'No note.',
        '',
        'Invite them from https://imagine.emberhub.dev/admin',
        '',
        ref,
      ].join('\n'), { replyTo: email, name: 'imagine' });
      return json({ ok: true, inboxed: toInbox(ref) });
    }

    if (f.action === 'invite') {
      var link = String(f.link || '');
      if (link.indexOf(SITE) !== 0 || !/^[A-Za-z0-9_-]{43}$/.test(link.slice(SITE.length))) return json({ ok: false, error: 'not an imagine invite link' });
      row(['invite', email, '']);
      GmailApp.sendEmail(email, "You're invited to try imagine", [
        'Hi,',
        '',
        "You're invited to try imagine: you sketch a website by talking and drawing, and it draws the pages for you.",
        '',
        'Your invite link (it is just for you):',
        link,
        '',
        'When it asks, type this email address: ' + email,
        '',
        'Only you and I can see your drawings. I look at them to learn what works and what doesn\'t.',
        'Reply to this email with anything that goes wrong, or anything you liked.',
        '',
        'Omar',
      ].join('\n'), { replyTo: ADMIN, name: 'Omar (imagine)' });
      return json({ ok: true });
    }

    return json({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

/** A row in the sheet, if one is set (Script Properties, SHEET_ID): a record that doesn't depend on mail. */
function row(cells) {
  var id = prop('SHEET_ID');
  if (id) SpreadsheetApp.openById(id).getSheets()[0].appendRow([new Date()].concat(cells));
}

/**
 * Mail you send yourself lands in Sent, not the Inbox, and the waitlist mail goes from this account to
 * this account. So it is found by its reference and moved to the Inbox, unread (as the Ember form does).
 */
function toInbox(ref) {
  for (var attempt = 0; attempt < 2; attempt += 1) {
    Utilities.sleep(attempt === 0 ? 900 : 1300);
    var found = GmailApp.search('"' + ref + '"', 0, 1);
    if (found.length) {
      found[0].moveToInbox().markUnread();
      return true;
    }
  }
  return false;
}

function doGet() {
  return json({ ok: false, error: 'post-only' });
}

function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
