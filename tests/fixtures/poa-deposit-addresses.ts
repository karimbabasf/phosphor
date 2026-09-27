// The deposit addresses the live POA bridge answered for account
// 0xd7b2de5862008d949dd6e5d70d4c68ad1d4d5050 on 2026-09-26, one per bridge key the app can now
// decode past the first six chains. Real mainnet addresses, so a decoder test proves a real
// address passes and a card test draws a row the real bridge would send. Stellar was asked in
// memo mode (its memo is 177690326). Read-only data: nothing here was ever signed or sent to.

export const POA_DEPOSIT: Readonly<Record<string, string>> = {
  'bch:mainnet': 'bitcoincash:qr9976ncxz2msd97ghn726kupk20m2wdmyn0fers4g',
  'ltc:mainnet': 'LhcjQUhN5RpxohmFWHdJjeyHM31LV7ApFV',
  'doge:mainnet': 'DAkzZgXDiVBQdAZbTA9MccZVKpN61ZfL8o',
  'dash:mainnet': 'XrV6ZA6UKa7sahkr6djZSA7BaoJGN3hZMP',
  'zec:mainnet': 't1ftzLVzeo23g6Bm8gv4K1yj7ip6RX7eRQf',
  'xrp:mainnet': 'rp6s4fyjoCzjZ7Pukt46UVek9LQq1X2xHe',
  'ton:mainnet': 'UQAWDVU4IWpL77kr7f_OQtQ_bdJ8mwNfKXiiqC819QWkN5A_',
  'tron:mainnet': 'TAhj7UQKSnVUNF5KC5PyAB8zPi4R4CmDHH',
  'sui:mainnet': '0xb3548ec172bd95ce13945a452a4559e86ba580671dc6c06ddd039f527ac955a4',
  'aptos:mainnet': '0x25e6559870641564220645a8cac7f5841135cfaf8512f325285f5487624726e5',
  'cardano:mainnet': 'addr1v9zt029u5eh2ggcuzv5se67qad7krlfzner9qdut0y74aegq6dv0p',
  'stellar:mainnet': 'GDJ4JZXZELZD737NVFORH4PSSQDWFDZTKW3AIDKHYQG23ZXBPDGGQBJK',
  'starknet:mainnet': '0x057ea27e45e07ee0bcab6f045e656c782a6789d14a25e8e70309c35b2ff6082d',
  'aleo:mainnet': 'aleo1pckgjagef5sxl70ts6k269ezrr2h8t69pwqcdp28c7mxw8s2hg9qmxgsat',
  'movement:mainnet': '0x186ed8e9c9214d39b0d25d5b6bb120e235c56e814764b662a2b2a34f1c1d9f5e',
  // The same answer for the EVM chains, Solana-shaped for Fogo, and the three the first six had.
  'fogo:mainnet': 'Dex4zi4VctZZp6fmyxouvYg7rkHxTdBrETzoWVtztiTR',
  'hypercore:mainnet': '0x248fe3b59B58Eb80CD3fde1bc27e0612650dACE7',
  'eth:1': '0x248fe3b59B58Eb80CD3fde1bc27e0612650dACE7',
  'sol:mainnet': 'dFTo67j9vq9u5XMGG24yhPgGMLstSMT5YQmyiAqekUS',
  'near:mainnet': 'fae3c94f710b683fd6b0580853dc8f20ed395f4325f57a0759a013839dc726f9',
  'btc:mainnet': 'bc1qdmxhkfvgl45uzwre8x27rmq764uxffezkmchjz',
};
