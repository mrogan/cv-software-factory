/**
 * The contact form: a valid message is accepted. The messages are plainly the factory's, so whoever reads the shop's
 * post can tell they need no reply. The form's fields are found by what they are (an email box, a message box), not
 * by what their labels say.
 */
import type { Evidence } from '@software-factory/events';
import type { BrowserCheck } from '../senses/browser.ts';
import { evidenceOf } from '../senses/http.ts';
import { badStatus, type Context, fail, type Shop, visit } from './site.ts';

/** Each of these sends a message to the shop, so they run once an hour. */
const HOUR = 60 * 60_000;
const FORM = 'main form:has(textarea)';
const PROBE =
  'This message is an automatic check by the Software Factory, which sends one each time it looks after the site. It needs no reply.';

/** What a page says when it has taken the message. */
const THANKS = /\b(thank you|thanks|on its way|(has|have|was|were) been (sent|received)|we('ll| will) be in touch)\b/i;
/** What it says when it has not. "Required" is no complaint: a form may label its fields so. */
const COMPLAINT = /\b(error|invalid|try again|failed|could not|couldn't)\b/i;

interface Message {
  name: string;
  email: string;
  /** What to write, to be shortened to the message box's limit. */
  text: string;
}

/** Fills the form in as a shopper would, sends it, and says what came of it: a finding if it was refused. */
async function send(context: Context, message: Message) {
  const { page } = context;
  const opened = await visit(context, '/contact');
  const bad = badStatus(opened.status, 'The contact page', opened.evidence);
  if (bad) return bad;
  const form = page.locator(FORM).first();
  if (!(await form.count())) {
    return fail('wrong-result', 'The contact page has no form with a box for a message.', {
      evidence: opened.evidence,
    });
  }
  const box = form.locator('textarea').first();
  const room = Number(await box.getAttribute('maxlength')) || 2_000;
  const email = form.locator('input[type="email"]').first();
  const name = form.locator('input[type="text"], input:not([type])').first();
  if (await name.count()) await name.fill(message.name);
  if (await email.count()) await email.fill(message.email);
  await box.fill(message.text.slice(0, Math.min(room, 1_500)));

  const posted = page.waitForResponse((r) => r.request().method() === 'POST', { timeout: 10_000 }).catch(() => null);
  await form.locator('button[type="submit"], input[type="submit"], button:not([type])').first().click();
  const response = await posted;
  await page.waitForLoadState('load');
  await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {});
  const evidence: Evidence[] = response ? [await evidenceOf(response)] : opened.evidence;
  const look = [{ selector: FORM, kind: 'problem' as const }];

  if (response && response.status() >= 500)
    return fail('server-error', `Sending a valid message answered ${response.status()}.`, { evidence, look });
  if (response && response.status() >= 400) {
    return fail('rejects-valid-input', `Sending a valid message answered ${response.status()}.`, { evidence, look });
  }
  // A page that thanks the visitor has taken the message, whatever else it still shows: some show the form again
  // under the banner, and a banner or a form's hints can use the words (and classes) of a complaint.
  const text = await page.locator('main').first().innerText();
  if (THANKS.test(text) && !COMPLAINT.test(text)) return null;
  // A page that shows the form again with a complaint has refused the message. One that shows no form took it.
  if (await page.locator(FORM).count()) {
    const complaint = page
      .locator('[role="alert"], [aria-invalid="true"], [class*="error" i], [class*="invalid" i]')
      .filter({ hasText: /\S/ });
    const said = (await complaint.count())
      ? await complaint
          .first()
          .innerText()
          .catch(() => '')
      : (text.match(new RegExp(`[^.\\n]*${COMPLAINT.source}[^.\\n]*`, 'i'))?.[0] ?? '');
    if (said.trim()) {
      return fail('rejects-valid-input', `The contact form refused a valid message: "${said.trim().slice(0, 120)}".`, {
        evidence,
        look,
      });
    }
  }
  return null;
}

export const contactAcceptsAMessage: BrowserCheck<Shop> = {
  id: 'contact-accepts-a-message',
  route: '/contact',
  every: HOUR,
  run: (context) => send(context, { name: 'Software Factory probe', email: 'probe@example.com', text: PROBE }),
};

export const contactAcceptsAwkwardButValidInput: BrowserCheck<Shop> = {
  id: 'contact-accepts-awkward-but-valid-input',
  route: '/contact',
  every: HOUR,
  run: (context) =>
    send(context, {
      name: "Zoë O'Brien-Smith",
      email: 'probe+factory@example.co.uk',
      text: `${PROBE}\n\nIt holds "quotes", an ampersand &, angle brackets <like this>, 100% and café, over two paragraphs.`,
    }),
};

export const contact = [contactAcceptsAMessage, contactAcceptsAwkwardButValidInput];
