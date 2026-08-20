# Third-party notices

phasr bundles the following third-party software.

**This file ships inside the application.** `src-tauri/tauri.conf.json`
lists it under `bundle.resources`, so it lands at
`Phasr.app/Contents/Resources/_up_/THIRD-PARTY-NOTICES.md` alongside a copy
of phasr's own `LICENSE`. That is what satisfies the MIT requirement that
the copyright notice be "included in all copies or substantial portions of
the Software" — before 0.4.0 the notices existed only in the git
repository, while the WASM they cover shipped in every DMG.

There is still **no in-app attribution surface** — the macOS About panel is
`PredefinedMenuItem::about` with no licence list, and there is no
Settings ▸ About screen. When one is added it should render this file from
the bundled resource rather than duplicating it.

Only components whose *source or binary* ships inside the app are listed
here; the full transitive dependency licences are in `pnpm-lock.yaml` and
`src-tauri/Cargo.lock`.

Deliberately **not** listed: `alacritty_terminal` (Apache-2.0). It is an
`optional` dependency behind the `vt-alacritty` cargo feature, which is not
in `default`, so no Apache-2.0 code is compiled into a release build. If
that feature is ever enabled by default, its notice must be added here.

---

## Terminal emulator

phasr renders every terminal with ghostty-web (see
`src/lib/terminal/factory.ts`).

### ghostty-web

MIT License. Copyright (c) 2025 Coder.

<https://github.com/coder/ghostty-web>

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

**Two further notices attach to this dependency:**

1. **Ghostty.** `ghostty-web` ships `ghostty-vt.wasm`, compiled from
   [Ghostty](https://github.com/ghostty-org/ghostty)'s own source with a
   small patch. That WASM — inlined as a `data:` URL inside
   `dist/ghostty-web.js` and therefore inside phasr's bundle — is Ghostty's
   code and carries Ghostty's licence:

   MIT License. Copyright (c) 2024 Mitchell Hashimoto, Ghostty contributors.

   ```
   Permission is hereby granted, free of charge, to any person obtaining a copy
   of this software and associated documentation files (the "Software"), to deal
   in the Software without restriction, including without limitation the rights
   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
   copies of the Software, and to permit persons to whom the Software is
   furnished to do so, subject to the following conditions:

   The above copyright notice and this permission notice shall be included in all
   copies or substantial portions of the Software.

   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
   SOFTWARE.
   ```

2. **Derived source in this repository.**
   `src/lib/terminal/backends/ghostty/osc8Provider.ts` is derived from
   `ghostty-web`'s `OSC8LinkProvider` (MIT, Coder) and carries the notice
   above. It is a hardened rewrite — upstream activates links with an
   unvalidated `window.open(uri)`; ours routes activation through phasr's
   `LinkSource` policy. See the file header and `docs/adr/ADR-002-terminal-engine.md`.

3. **Local patch.** `patches/ghostty-web@0.4.0.patch` modifies the
   published package:
   - adds `pause()`/`resume()` to the otherwise unconditional render loop;
   - fixes a `document` listener leak on dispose;
   - makes selection a translucent wash over the normally painted cell
     instead of inverse video, and leaves selected glyphs
     their own colour unless a theme sets `selectionForeground`;
   - honours DEC mode 2026 (synchronized output), bounded by a 150 ms
     timeout, so a frame split across two PTY reads is not painted
     half-applied.

   The MIT licence permits this; the patch is intended for upstreaming.
