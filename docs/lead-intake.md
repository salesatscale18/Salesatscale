# Lead intake API

Send leads from a website form or CRM to Sales at Scale. Create a key in
**Settings → Lead intake from your website** of the seller account. Call the API
from your **server**, never from the browser, so the key stays secret.

```
POST https://<app-domain>/api/leads/<account-slug>
Authorization: Bearer <intake key>
Content-Type: application/json
```

## Body

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Full name |
| `phone` | yes | WhatsApp number. International format (`+972…`) or national for the account's market |
| `company` | no | Business name |
| `language` | no | `en` or `he` (also `English`, `Hebrew`). Defaults to the account's first language |
| `source` | no | Label shown in the leads list. Default `Website form` |
| `source_id` | no | Your ID for this lead; used to match updates |
| `consent.given` | yes for a new lead | Must be `true`. A lead without consent is rejected |
| `consent.source` | yes with consent | Where and how they agreed, e.g. `Contact form on /pricing` |
| `consent.wording` | no | Exact text they agreed to. Default: "This person asked to be contacted on WhatsApp" |
| `consent.captured_at` | no | ISO time. Default: now |
| `consent.page_url` | no | Page where they agreed |
| `consent.ip` | no | Defaults to the caller's IP |

```json
{
  "name": "Shira Golan",
  "company": "Golan Bakery",
  "phone": "+972 52 555 0193",
  "language": "he",
  "source_id": "crm-4512",
  "consent": {
    "given": true,
    "source": "Contact form on golanbakery.example/contact",
    "wording": "I agree to be contacted on WhatsApp about temperature monitoring",
    "page_url": "https://golanbakery.example/contact"
  }
}
```

## Responses

| Status | Meaning |
|---|---|
| `201` `{ "id", "created": true, "status" }` | New lead created |
| `200` `{ "id", "created": false, "status" }` | A lead with the same phone or `source_id` existed and was updated |
| `400` `invalid_json` | Body is not a JSON object |
| `401` `unauthorized` | Missing, wrong or revoked key, or a key for another account |
| `409` `phone_conflict` | The `source_id` matches one lead but the phone belongs to another |
| `413` `payload_too_large` | Body over 32 KB |
| `422` `invalid_lead` / `consent_required` | Fields failed validation (`fields` says which), or a new lead has no consent |

Opted-out leads stay opted out when they are sent again.
