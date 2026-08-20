# ui/vendor

Third-party code, copied in whole and pinned. Nothing here is written by this project and
nothing here is fetched at runtime: the app must run with the network unplugged, and a remote
script tag on a page that holds an approval button is somebody else's key to the wallet.

## three.js 0.181.2

    three.module.min.js   355,035 bytes   the renderer, materials, geometry
    three.core.min.js     380,264 bytes   math and buffer primitives, imported by the file above

    sha256  979c1ae4b0579c9901eacf797602c0b46df129d87102c6443d14be4a1f790b70  three.module.min.js
    sha256  295a28f4a9786dd24a2a357a4ce90921eb041127e53a508335b9a0556c1e0875  three.core.min.js

Copied byte for byte from Warden's own installed dependency, which is where the globe this
app draws comes from:

    cp ~/Developer/Apps/WARDEN/node_modules/three/build/three.module.min.js ui/vendor/
    cp ~/Developer/Apps/WARDEN/node_modules/three/build/three.core.min.js  ui/vendor/

Warden pins `three: ^0.181.2` in `web/package.json`. Taking the build from there rather than
from a fresh download means the two apps draw the same globe with the same renderer, and it
is a version already running on this machine rather than a new one nobody has looked at.

`three.module.min.js` imports `./three.core.min.js`. The two must stay side by side, and both
must be replaced together on any upgrade. Only `ui/warden-globe.js` loads them, and only when
a WebGL globe is actually put on screen: the 735 KB never reaches a browser that falls back to
the 2D globe.

MIT, Copyright 2010-2025 Three.js Authors. The licence header is at the top of each file.
