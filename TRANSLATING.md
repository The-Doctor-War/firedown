# Translating Firedown

Firedown's interface is translated by the community through
[Weblate](https://weblate.org), a web-based translation platform. You don't
need to know Git or write any code to help.

## How to contribute a translation

1. Go to the Firedown project on Hosted Weblate:
   **<https://hosted.weblate.org/projects/firedown/>**
2. Sign in (you can use a GitHub account) and pick your language. If your
   language isn't listed yet, use **Start new translation** to add it.
3. Translate the untranslated strings. Weblate shows suggestions, glossary
   terms, and machine-translation hints to help.
4. Save. Your changes are committed to Weblate and periodically opened as a
   pull request against this repository — no further action needed.

## Guidelines

- **Keep placeholders intact.** Tokens like `%s`, `%d`, and `%1$s` must appear
  in the translation exactly as in the source. Weblate will flag mismatches.
- **Keep formatting tags** such as `<b>…</b>` or `\n` where they appear.
- **Don't translate** the app name "Firedown", URLs, or brand names
  (YouTube, uBlock Origin, GeckoView, etc.).
- **Match the tone:** concise and friendly, matching Android conventions for
  your language.
- When unsure about a string's context, leave a comment on it in Weblate.

## For maintainers

The source strings live in
[`app/src/main/res/values/strings.xml`](app/src/main/res/values/strings.xml);
translations live in the matching `values-<locale>/strings.xml` files. Weblate
is configured against the `app` component of the `firedown` project on Hosted
Weblate and syncs automatically with this repository.

The [`.weblate`](.weblate) file at the repo root configures the
[`wlc`](https://docs.weblate.org/en/latest/wlc.html) command-line client. To
use it, install `wlc` and add your API key:

```bash
pip install wlc
# ~/.config/weblate or a local .weblate-credentials
wlc --config-section weblate pull   # pull latest translations
wlc commit                          # commit pending changes in Weblate
```

Never commit your Weblate API key to the repository.
