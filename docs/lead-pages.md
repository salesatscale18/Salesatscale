# Lead pages: putting our form on your page, or using your own

Lead pages bring buyers from an ad or a landing page straight into a conversation.
This note covers **Our form on your page** (the snippet) and **Your own form**.
"Button or link" needs no install: put the page's link (`/p/<key>`) on a button or an ad.
Its page address is optional (it is shown in the list and the page view only).

The form asks for the name and mobile number; the seller can add Company and Email (both optional).

## The snippet

Copy it from Lead pages › your page › **Your snippet**. It has two lines:

```html
<div data-sas-lead-form="YOUR_PAGE_KEY"></div>
<script async src="https://APP_HOST/lp/v1.js"></script>
```

- Put the `<div>` where the form should appear (usually near the bottom of the page).
  The script can go right after it, or anywhere else on the page (also in the `<head>`).
- Several placeholders on one page each get their own form. A placeholder added later
  (a popup, a single-page app, a builder that renders late) is found automatically.
- The form takes your page's font and your brand colour (Setup › Order form). Your page's
  CSS cannot change the form, and the form's CSS cannot change your page (Shadow DOM).
- Page edits (fields, consent box, topic, brand colour) need no reinstall: the snippet
  reads them when the page loads (cached for at most a minute).
- The script sets no cookies and never loads ad scripts. The only thing it keeps is the
  visit's ad details (UTM values, click IDs, the referring site), in `sessionStorage`, and
  only when your cookie banner says analytics is granted, so a buyer who lands on one page
  with `?utm_campaign=…` and leaves details on another page of the same visit still carries
  the campaign. Unknown or denied: only the current address's details are sent, nothing is
  kept (denied also clears what was kept).

### Which addresses may show the form

The form works only on the page's address, its `www.` twin, and the **other addresses**
you add (for example a staging site such as `acme.webflow.io`). Each address is matched
exactly: scheme (https), host and port. There are no wildcards. If the form is placed on
an address that is not allowed, it does not show, and the page view says
**"Seen on <host>. Add it?"** so you can allow it with one click.

### Try it before going live

On the page view, **Get a preview link**. It opens your page with `#sas-preview=…` at the
end of the address. With it, a draft page shows the form too, and test leads are marked as
tests and left out of the numbers. It works for 24 hours. The fragment never leaves the browser.

The check **"The snippet was seen on your page"** ticks the first time the form loads on an
allowed address.

### Ad tracking

- **Tell my page's ad pixel when a lead is sent** (on by default): after a buyer sends the
  form, the snippet calls the pixel that is already on your page: Meta `fbq('track', 'Lead', {}, {eventID})`
  and Google `gtag('event', 'generate_lead')` (or a `dataLayer` push when there is only
  Google Tag Manager). If your page has no pixel, nothing is called. Test leads from a preview
  link are never reported.
- **Carry ad details through to the lead**: UTM values and ad click IDs (gclid, fbclid, …)
  from the page address go with the lead.
- Visits and form opens are counted without cookies. When your cookie banner says
  "denied" (IAB TCF, Google Consent Mode, Cookiebot or OneTrust), nothing is counted.
  The buyer's details are always sent.

After sending, the buyer goes to our hand-over page in the same tab, then to the conversation.

## Your own form

Keep the form you already have and point it at us. The buyer still takes one step: they
send your form and land on our hand-over, then the conversation.

### Set up

1. Lead pages › **Add page** › **Your own form**. Enter the address of the page your form is on
   (optional, but recommended: without it, and with no other addresses, your form's sends are
   refused until you allow the address; the page view then shows **"Seen on <host>. Add it?"**).
2. Save. The page view shows **Your form's address**:
   `https://APP_HOST/api/lp/<key>/submit`.
3. Set your form's `action` to that address and its `method` to `post`. The browser sends
   it as a normal form (`application/x-www-form-urlencoded`); no script is needed.

### Field names

| Field | Also accepted | |
|---|---|---|
| `name` | `full_name` | required |
| `phone` | `tel`, `mobile` | required |
| `company` | `business` | optional |
| `email` | | optional |
| `consent` | | `true`, `on`, `yes` or `1` when the box is ticked |

Other fields are ignored. Ad details arrive when your form sends them as hidden fields:
`utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content` and the click IDs
`gclid`, `gbraid`, `wbraid`, `fbclid`, `msclkid`, `ttclid`, `li_fat_id` (with
**Carry ad details** on).

A minimal example (the page view has one ready to copy, with your names in the consent line):

```html
<form method="post" action="https://APP_HOST/api/lp/YOUR_PAGE_KEY/submit">
  <label>Full name <input name="name" autocomplete="name" required></label>
  <label>Mobile number <input name="phone" type="tel" autocomplete="tel" required></label>
  <label><input type="checkbox" name="consent" value="yes"> Your consent text</label>
  <input name="sas_url" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px">
  <button type="submit">Send</button>
</form>
```

### Consent

You are responsible for the consent text on your own form: we cannot see it. A lead gets
consent only when your form sends `consent` as `true`, `on`, `yes` or `1`. We record that the
buyer ticked the box on your form, the page address (without its query) and their IP; the
wording kept is "Seller's own form on <host/path>". The page view shows our recommended line
to copy.

Without consent the lead is still saved, but the agent does not contact them (no chat, no
SMS); they see "<your company> received your details and will get back to you." As with our
own form, sending the form never gives consent back to an existing lead that has none.

### What happens after sending

- Accepted: `303` to our hand-over page (`/h/…`), the same as with our form.
- Refused (a missing name or phone, too many attempts, a paused page): `303` back to the page
  the form was on, with `?sas_error=<code>` added. The redirect never carries the buyer's
  details, drops the page's own query, and goes only to the page the form was sent from when
  that page is on an allowed address.
- From an address that is not allowed, or with no `Origin` and no `Referer` header: no
  redirect, `403` with a small styled page showing one sentence in the form's language (the
  generic one below; "too many attempts" and "not taking requests" for `busy` and `closed`).
  It has no scripts, no external files and nothing from the request. The page view then says
  **"Seen on <host>. Add it?"**. A page key that is not found (or a draft without a test code)
  gets the same styled page with `404`. Callers sending JSON keep their JSON answers.

#### If a send is refused

Your page opens again with `?sas_error=` in its address. Show your own message for each code.
The page view shows the same table, with the sentences in the page's form language. The codes
come from one list (`OWN_FORM_ERRORS` in `lib/lead-pages/rules.ts`, sentences in
`lib/lead-pages/refusal.ts`).

| Code | What it means | Suggested sentence (English / Hebrew) |
| --- | --- | --- |
| `name` | The name is missing. | Enter your name. / יש להזין שם. |
| `phone` | The mobile number is missing or not valid. | Enter a valid mobile number. / יש להזין מספר נייד תקין. |
| `busy` | Too many sends in a short time. | Too many attempts. Please try again in a few minutes. / יותר מדי ניסיונות. אפשר לנסות שוב בעוד כמה דקות. |
| `closed` | The page is paused. | This form is not taking requests right now. / הטופס לא מקבל פניות כרגע. |
| `generic` | Anything else went wrong. | Something went wrong. Please try again. / משהו השתבש. אפשר לנסות שוב. |

A lead sent without consent is not refused: it is saved, and the buyer sees that you received
their details.

### Spam and limits

- Only allowed addresses can send (the page's address, its `www.` twin and the **other
  addresses** you add). We read the browser's `Origin` header, else the `Referer`'s host. A
  page with `Referrer-Policy: no-referrer` may send neither; then the form is refused.
- Rate limits per IP address, per page and per phone number, as for our own form.
- Optional honeypot: a field named `sas_url`, hidden from people (not `type="hidden"`, which
  some bots skip). A form sent with it filled in looks successful but creates no lead.
- There is no timing check on your own form (it cannot carry our token).
- Visits and form opens cannot be counted on your page (our script is not there): the page
  view shows a dash for them. Leads, chats, quotes and orders are counted as usual.

### Test before going live

On the page view, **Get a test code** and add it to your form as a hidden field
(`<input type="hidden" name="preview" value="…">`). Send your form once from your page: the
lead arrives marked **Test** and is left out of the numbers. A draft page accepts only these
test sends. The code works for 24 hours; remove the field before going live.
The check **"A lead arrived from your form"** ticks with the first lead your form sends.

## Page builders

**WordPress (block editor).** Add a *Custom HTML* block where the form should be and paste
both lines. With a page builder plugin, use its HTML/code widget. Caching and "optimise JS"
plugins: exclude `lp/v1.js` from combining or delaying if the form does not appear.

**Webflow.** Drag an *Embed* element (Add › Components › Code Embed) where the form should be
and paste both lines. Publish the site; the Designer preview does not run custom code. Add
your `*.webflow.io` staging address under **Other addresses** to test there.

**Squarespace.** Add a *Code* block (Business plan or higher) and paste both lines. Make sure
"Display source" is off.

**Elementor.** Add the *HTML* widget where the form should be and paste both lines. In
Elementor popups the form appears when the popup opens.

**Wix.** Wix's *Embed HTML* element runs code inside a sandboxed frame, so after sending the
buyer may need to tap **Continue to the chat** instead of moving on by themselves. For the
smoothest result: put the `<div>` line in an *Embed HTML* element and add the `<script>` line
under Settings › Custom Code (all pages, body end), or use **Button or link** instead.

**Framer.** Add an *Embed* component (type HTML) where the form should be and paste both
lines. Publish to see it; Framer's canvas does not run scripts. Add your `*.framer.app`
staging address under **Other addresses** to test there.

## Content Security Policy (CSP)

If your site sends a `Content-Security-Policy` header, allow our host for the script and for
its requests:

```
script-src  … https://APP_HOST;
connect-src … https://APP_HOST;
```

No `frame-src`, `style-src` or `img-src` change is needed: the form is not an iframe, its
styles live inside the form, and it loads no images. The privacy notice link opens on our host
in a new tab.

## For developers

- `public/lp/v1.js` is hand-written ES2019 with no dependencies, at most 12 KB gzipped
  (`tests/unit/lead-page-snippet.test.ts` checks both). It stays backward compatible;
  breaking changes ship as `/lp/v2.js`. Its pure logic mirrors `lib/lead-pages/snippet-core.ts`.
- Endpoints (all CORS for the page's allowed origins only, no credentials):
  `GET /api/lp/<key>/config`, `POST /api/lp/<key>/submit` (text/plain JSON),
  `POST /api/lp/<key>/e` (view/open counts).
- `POST /api/lp/<key>/submit` also takes `application/x-www-form-urlencoded` (the seller's
  own form, and our hosted form without JavaScript) and answers with `303` redirects.
- Sending leads from your own server instead belongs on the intake API with a key
  (`docs/lead-intake.md`): the lead page endpoints refuse requests with no browser origin.
