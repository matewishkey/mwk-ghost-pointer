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

## Publishing rules learned the hard way (31 Aug 2026)

**Bump the version for every published build.** The filename carries the version, so a new
version is a new URL — no collision with a cached copy, no stale asset, nothing to retract.
Mate's call, and it is the reason the two rules below exist rather than the cure for them.

**Cloudflare Pages does not un-publish a file when you stop uploading it.** An asset stays
addressable across deployments in the project, so removing the broken Windows installer from
`public/` left it downloadable. Withdrawing something needs a `_redirects` entry (build.sh
writes one), or the deployments that contained it deleted.

**Never verify a Pages deploy by status code.** Pages answers `200` with `index.html` for any
path it cannot find, so a missing file and a present one look identical. Compare the bytes or
the content type — `curl -o` then `file --mime-type`. A "404 check" here is not a check.
