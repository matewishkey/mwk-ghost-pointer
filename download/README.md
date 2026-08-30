# download/ — the public download page

Serves **https://ghost-pointer-app.matewishkey.com**: the built macOS app, plus the one page
that explains how to get past Gatekeeper on an unsigned build.

    cd app && npm run tauri build -- --target universal-apple-darwin   # on the Mac
    ./download/build.sh                                               # assembles download/public/
    # then, on the Linux box (it holds the Cloudflare token):
    wrangler pages deploy download/public --project-name ghost-pointer-app

`template.html` is the source; `public/` is generated and gitignored. `build.sh` reads the
version, size, hash and default hotkey out of the actual build rather than restating them, so
the page cannot drift from what it is serving.

**Why the deploy is split across two machines:** only a Mac can build a Mac app, and only the
Linux box has the Cloudflare credentials — this observer Mac deliberately holds no age key.
