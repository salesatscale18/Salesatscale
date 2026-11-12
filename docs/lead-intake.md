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
| `full_name` | yes | Full name (`name` also accepted) |
| `phone` | yes | WhatsApp number. International format (`+972…`) or national for the account's market |
| `language` | no | `en` or `he` (also `English`, `Hebrew`). Defaults to the account's first language |
| `business` | no | Business name (`company` also accepted) |
| `email` | no | Email address |
| `source` | no | Label shown in the leads list. Default `Website form` |
| `source_id` | no | Your ID for this lead; used to match updates |
| `consent.source` | yes for a new lead | Where and how they agreed, e.g. the form's page |
| `consent.text` | yes for a new lead | Exact wording they agreed to |
| `consent.at` | no | ISO time they agreed. Default: now |
| `consent.page_url` | no | Page where they agreed |
| `consent.ip` | no | Defaults to the caller's IP |

```json
{
  "full_name": "Rina Cohen",
  "phone": "+972545551842",
  "language": "he",
  "business": "Rina's Kitchen",
  "source_id": "form-88213",
  "consent": {
    "source": "yoursite.example/contact",
    "text": "I agree to be contacted on WhatsApp about temperature monitoring",
    "at": "2026-11-09T09:12:00Z"
  }
}
```

Every call (accepted or rejected) appears under **Recent deliveries** in the same Settings page.

## Responses

| Status | Meaning |
|---|---|
| `201` `{ "id", "created": true, "status" }` | New lead created |
| `200` `{ "id", "created": false, "status" }` | A lead with the same phone or `source_id` existed and was updated |
| `400` `invalid_json` | Body is not a JSON object |
| `401` `unauthorized` | Missing, wrong or revoked key, or a key for another account |
| `409` `opted_out` | This person opted out. They are never re-added without new consent |
| `409` `phone_conflict` | The `source_id` matches one lead but the phone belongs to another |
| `413` `payload_too_large` | Body over 32 KB |
| `422` `invalid_lead` / `consent_required` | Fields failed validation (`fields` says which), or a new lead has no consent source and text |

