# Example configuration

Two ready-to-use files (fictional data — replace with your own):

| File | What it is | How to use |
| --- | --- | --- |
| `settings.example.json` | A complete JobSmith `Settings` object: job criteria, a filled résumé, autofill values, notification/engine/privacy defaults. | **Settings → Privacy & safety → Import settings**, pick this file, then edit. |
| `resume.example.json` | Just the structured `ResumeData` portion, if you only want a résumé template to follow. | Reference for how to fill the **Résumé** tab (it isn't imported directly — the Résumé tab is form-based). |

Notes:

- `settings.example.json` is schema-accurate (generated from the extension's own defaults), so
  importing it works out of the box.
- Importing settings **replaces** your current settings (your tracked applications are kept).
  Export your existing settings first if you want a backup.
- The example targets a remote Software Engineer search from India (`worldwide`, `anywhere`,
  `global`, `india`, `remote` locations) — tweak `jobSearch` for your own search.
