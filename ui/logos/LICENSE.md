# Token and chain logos

Every file here except `hype.svg` and `base.svg` is the "branded" SVG from `@web3icons/core` 4.0.56
(https://github.com/0xa3k5/web3icons), MIT licensed, extracted as a plain `.svg`, with three
exceptions taken from `spothq/cryptocurrency-icons` 0.18.1, CC0: `xrp.svg` and `wbtc.svg` are
that set's disc versions, because the web3icons marks for those two are white glyphs alone and
would vanish on a light surface, and `xlm.svg` is too, because the web3icons mark for it is a
black glyph alone and would vanish on a dark one. Those three discs fill their whole box, so each
file's `viewBox` is widened to put the disc in the middle three quarters of it, where every
web3icons mark sits, and a row of logos reads at one size.

`frax.svg`, `xaut.svg` and `aleo.svg` are the same package's "background" versions for the same
reason (FRAX's and XAUT's branded marks are white glyphs, ALEO's a black one), with the square
tile each is drawn on cut to its disc and the `viewBox` widened the same way.

`hype.svg` is Hyperliquid's own mark (Hyperliquid_Blob_Green.svg from the brand kit linked at
https://hyperliquid.gitbook.io/hyperliquid-docs/brand-kit). It is a trademark of Hyperliquid,
used here under the brand kit's terms to identify the venue, and is not MIT.

`base.svg` is Base's round symbol (the blue disc with its bar, #0052FF, from Base's brand kit at
https://base.org), drawn into the middle three quarters of a 24 unit box. The package's Base
file is the flat square block, the one mark in a list of round ones. It is a trademark of Coinbase,
used here to identify the network, and is not MIT.

`pepe.svg` is the package's file with its square photo tile cut to the disc every other mark
sits in. The dark discs (`xlm.svg`, `xrp.svg`, `fxrp.svg`, `wbtc.svg`, `xaut.svg`, `frax.svg`,
`xpl.svg`, `xlayer.svg`, `aleo.svg`, `strk.svg`, `usde.svg`) each carry one added element, a
faint light ring on the disc's own edge (`data-edge="light"`), so a black or navy disc does not
vanish on the window's warm charcoal. Nothing else in any mark is changed.

Chain marks (`arb.svg`, `ton.svg`, `abs.svg`, `bera.svg`, `mon.svg`, `move.svg`,
`robinhood.svg`, `scroll.svg`, `strk.svg`) are the network icons from the same package.
`strk.svg` is the Starknet network icon rather than the package's STRK token file, because that
file draws another project's mark. `xpl.svg` (Plasma, whose coin the package's own metadata draws
with the network icon) and `xlayer.svg` (X Layer) are network icons too, in the "background"
version because their branded marks are black glyphs alone, cut to a disc as above.

A wrapped or bridged ticker's file is a byte copy of the file for the coin it carries, under that
file's license: `weth.svg` of `eth.svg`; `cbbtc.svg`, `hemibtc.svg`, `xbtc.svg`, `nbtc.svg` and
`btc(omni).svg` of `btc.svg`; `usdt0.svg` of `usdt.svg`; `usdc.e.svg` and `usdcx.svg` of
`usdc.svg`; `xdai.svg` of `dai.svg`; and `fxrp.svg` of `xrp.svg`. What tells two of them apart in
one list is the badge `ui/design/marks.js` draws on the copy (BADGES), not the file.

## MIT License (@web3icons/core)

Copyright (c) 2024 0xa3k5

Permission is hereby granted, free of charge, to any person obtaining a copy of this software
and associated documentation files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
