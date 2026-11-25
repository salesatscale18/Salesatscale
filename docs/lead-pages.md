# Lead pages: putting our form on your page

Lead pages bring buyers from an ad or a landing page straight into a conversation.
This note covers **Our form on your page** (the snippet). "Button or link" needs no
install: put the page's link (`/p/<key>`) on a button or an ad.

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
- The script sets no cookies, uses no browser storage and never loads ad scripts.

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
- Sending leads from your own server instead belongs on the intake API with a key
  (`docs/lead-intake.md`): the lead page endpoints refuse requests with no browser origin.
