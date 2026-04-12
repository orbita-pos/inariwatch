/**
 * Disposable email blocklist for signup hardening.
 *
 * This list covers the ~200 most popular disposable / temporary email
 * services. It's not exhaustive (new services pop up weekly) but blocks
 * the vast majority of obvious throwaway addresses.
 *
 * For domains that aren't in the static list, set
 * `DISPOSABLE_EMAIL_OVERRIDES=domain1.com,domain2.io,...` in env vars.
 * This lets you block newly-discovered abuse vectors without a deploy.
 *
 * Sources used to build this list:
 *   - https://github.com/disposable-email-domains/disposable-email-domains
 *   - https://github.com/wesbos/burner-email-providers
 */

const STATIC_DISPOSABLE: ReadonlySet<string> = new Set([
  // Top tier — used in 90%+ of disposable signups
  "10minutemail.com", "10minutemail.net", "20minutemail.com", "30minutemail.com",
  "33mail.com", "guerrillamail.com", "guerrillamail.net", "guerrillamail.org",
  "guerrillamail.de", "guerrillamail.biz", "guerrillamailblock.com",
  "sharklasers.com", "grr.la", "spam4.me", "pokemail.net",
  "mailinator.com", "mailinator.net", "mailinator.org", "mailinator2.com",
  "mailnesia.com", "mailtothis.com", "mailtemp.info", "mailcatch.com",
  "tempmail.com", "tempmail.net", "tempmail.de", "temp-mail.org", "temp-mail.io",
  "tempmailaddress.com", "tempmailo.com", "tempemail.com", "tempemail.net",
  "tempinbox.com", "tempemails.io", "temporarymail.com",
  "yopmail.com", "yopmail.fr", "yopmail.net", "cool.fr.nf", "jetable.fr.nf",
  "trashmail.com", "trashmail.de", "trashmail.io", "trashmail.me",
  "trashmail.net", "trashmail.ws", "trash-mail.com", "trash-mail.de",
  "throwawaymail.com", "throwam.com", "throwawayemailaddress.com",
  "fakeinbox.com", "fakemailgenerator.com", "fakemail.net",
  "maildrop.cc", "maildrop.tk", "discard.email", "discardmail.com",
  "discardmail.de", "spamgourmet.com", "spamgourmet.net", "spamgourmet.org",
  "spambox.us", "spambog.com", "spambog.de", "spambog.ru",
  "spam.la", "spam.su", "binkmail.com",
  "mintemail.com", "mailnull.com", "moakt.com", "moakt.cc",
  "tempr.email", "discard.email", "fastmail.fm", "tempinbox.co.uk",
  "tempymail.com", "anonymbox.com", "anonbox.net", "anonymousemail.me",
  "deadaddress.com", "dispostable.com", "incognitomail.com",
  "incognitomail.net", "instant-mail.de", "kasmail.com", "letthemeatspam.com",
  "linshiyou.com", "lookugly.com", "luxusmail.org", "mail-temporaire.fr",
  "mailbidon.com", "mailbiz.biz", "mailblocks.com", "mailbox80.com",
  "mailboxxx.net", "mailcatch.com", "maileater.com", "mailfreeonline.com",
  "mailimate.com", "mailin8r.com", "mailinator.us", "mailmoat.com",
  "mailmoth.com", "mailnator.com", "mailnesia.com", "mailshell.com",
  "mailsiphon.com", "mailslapping.com", "mailtome.de", "mailzilla.com",
  "mbx.cc", "mintemail.com", "moncourrier.fr.nf", "monemail.fr.nf",
  "monmail.fr.nf", "mt2009.com", "mx0.wwwnew.eu", "mycleaninbox.net",
  "myemailboxy.com", "mypartyclip.de", "myphantomemail.com",
  "neverbox.com", "no-spam.ws", "nobulk.com", "noclickemail.com",
  "nogmailspam.info", "nomail.xl.cx", "nomail2me.com", "nospam.ze.tc",
  "nospam4.us", "nospamfor.us", "nospamthanks.info", "notmailinator.com",
  "nowmymail.com", "nurfuerspam.de", "nus.edu.sg", "objectmail.com",
  "obobbo.com", "odaymail.com", "oneoffemail.com", "oopi.org",
  "ordinaryamerican.net", "otherinbox.com", "ourklips.com", "outlawspam.com",
  "ovpn.to", "owlpic.com", "pancakemail.com", "pjjkp.com",
  "plexolan.de", "poofy.org", "popconstantine.com", "privacy.net",
  "privatdemail.net", "proxymail.eu", "putthisinyourspamdatabase.com",
  "qq.com", "quickinbox.com", "rcpt.at", "reallymymail.com",
  "recode.me", "recursor.net", "rmqkr.net", "royal.net",
  "rtrtr.com", "s0ny.net", "safe-mail.net", "safersignup.de",
  "safetymail.info", "safetypost.de", "sandelf.de", "saynotospams.com",
  "selfdestructingmail.com", "sendspamhere.com", "shieldedmail.com",
  "shiftmail.com", "shitmail.me", "shitware.nl", "showslow.com",
  "sibmail.com", "skeefmail.com", "slaskpost.se", "slopsbox.com",
  "smashmail.de", "smellfear.com", "snakemail.com", "sneakemail.com",
  "sofimail.com", "sofort-mail.de", "softpls.asia", "spam.la",
  "spam.su", "spam4.me", "spamavert.com", "spambob.com", "spambob.net",
  "spambob.org", "spamcannon.com", "spamcannon.net", "spamcero.com",
  "spamcorptastic.com", "spamcowboy.com", "spamcowboy.net", "spamcowboy.org",
  "spamday.com", "spamex.com", "spamfree24.com", "spamfree24.de",
  "spamfree24.eu", "spamfree24.info", "spamfree24.net", "spamfree24.org",
  "spamhereplease.com", "spamhole.com", "spamify.com", "spaminator.de",
  "spamkill.info", "spamlot.net", "spammotel.com", "spamoff.de",
  "spamslicer.com", "spamspot.com", "spamthis.co.uk", "spamtroll.net",
  "speed.1s.fr", "supergreatmail.com", "supermailer.jp", "suremail.info",
  "teleworm.com", "thanksnospam.info", "thankyou2010.com", "thecloudindex.com",
  "thisisnotmyrealemail.com", "throwawayemailaddresses.com",
  "tilien.com", "tmailinator.com", "toiea.com", "tradermail.info",
  "trbvm.com", "tyldd.com", "uggsrock.com", "upliftnow.com",
  "uplipht.com", "venompen.com", "veryrealemail.com", "viditag.com",
  "viralplays.com", "vpn.st", "vsimcard.com", "vubby.com",
  "wegwerfemail.com", "wegwerfemail.de", "wegwerfemail.net", "wegwerfemail.org",
  "wegwerfmail.de", "wegwerfmail.info", "wegwerfmail.net", "wegwerfmail.org",
  "wh4f.org", "whyspam.me", "willhackforfood.biz", "willselfdestruct.com",
  "winemaven.info", "wronghead.com", "wuzup.net", "wuzupmail.net",
  "xagloo.com", "xemaps.com", "xents.com", "xmaily.com",
  "xoxy.net", "yapped.net", "yeah.net", "yep.it", "ypmail.webarnak.fr.eu.org",
  "yuurok.com", "zehnminuten.de", "zehnminutenmail.de", "zoaxe.com",
  "zoemail.com", "zoemail.net", "zoemail.org", "ipoo.org",
  "tafmail.com", "mfsa.ru", "totalvista.com", "tradermail.info",
  "vmailing.info", "wegwerf-emails.de", "yapped.net",
]);

const OVERRIDES: ReadonlySet<string> = new Set(
  (process.env.DISPOSABLE_EMAIL_OVERRIDES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

/**
 * Check whether an email address uses a disposable / temporary domain.
 * Returns true for malformed addresses (no `@` or no domain) — those are
 * invalid anyway and shouldn't reach the database.
 */
export function isDisposableEmail(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at < 0 || at === email.length - 1) return true;
  const domain = email.slice(at + 1).toLowerCase().trim();
  if (!domain) return true;
  return STATIC_DISPOSABLE.has(domain) || OVERRIDES.has(domain);
}
