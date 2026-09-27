// Every network the chain reader knows, read live off mainnet through src/chainscan, read only.
//
// For each network: its chain head (height and how old the latest block is), the balance and
// transaction count of an address that was active on 2026-09-26 (so a parse that failed would
// show as a missing number, not a quiet zero), and the status of one transaction from that day.
// Nothing is signed or sent; the only requests are the module's own guarded reads, so the
// allowlist, the byte caps and the per-host buckets are exactly the ones the app runs with.
//
// Run: node scripts/chain-reader-live.ts [network ...]

import { addressActivity, chainHead, CHAIN_NETWORKS, createChainFetchState, isChainNetwork, NETWORKS, transaction } from '../src/chainscan/index.ts';
import type { ChainNetwork } from '../src/chainscan/index.ts';

// An address and a transaction per network, both seen live on 2026-09-26. The EVM rows are the
// sender of a recent block's transaction; the rest are a busy public account (the TON
// Foundation, Robinhood's Dogecoin wallet, a Binance cold wallet) or the account's own POA
// deposit address where that holds a balance.
const SAMPLES: Readonly<Record<ChainNetwork, { address: string; tx: string | null }>> = {
  ethereum: { address: '0x675776a3b91e310e65fa310cc7186af7b6bf5e1b', tx: '0x2e29090c0097b06b32c6746b097dc1357d4322198db89df46932084ea33027bd' },
  base: { address: '0xf9b6a1eb0190bf76274b0876957ee9f4f508af41', tx: '0x4c3d4f1b8d30bc5722cfed81a335600145a17d0c43cc0ef3255767b51c27802e' },
  arbitrum: { address: '0x2515051846249d74238d2e5b2d2d33f888d0790e', tx: '0xc4ad481119309747661c4b913a6ce0d28fcc209926fc1a610b9b6517f0f37b12' },
  solana: { address: 'EWyc5ZVCuhr9y8Hx3UPFGe6Udpra3nYGWT4Y3f2bRcVT', tx: '5emE5TiSbzeRZFjvFkpBEBnzZAU7ZqatrYAStBUz364L72stKfsFb5rD1zzioTAjW9guRCzGHuQEVQe8M5gKT6k4' },
  near: { address: 'intents.near', tx: '2b2oBzg7YrSo6jAyMkvJaijh6YNNMqPH6DfXs7DdpNnm' },
  bitcoin: { address: '34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo', tx: '4e09836ddf2f1a49508a6181a78a0dc170016224f43a05129903cf3316500fde' },
  optimism: { address: '0x9e3ed65340a913b96ba7b86d5d5876dde623946e', tx: '0x46e0a62630b76fbb65b819669b28a95c77b1b4f16bb52a07f3faffae904b1895' },
  gnosis: { address: '0x5ecf14e7a3831d44e2f7d4542ba98c6c96e47420', tx: '0x38bdfb1abee2ece95845c72194baf3c49fa942cf8dc97eadaacef83d07de3df9' },
  polygon: { address: '0xc8edeb88bf3df13f19172eff9dd7c00778afc99a', tx: '0x591fec0abd1a7c40754e05292017e5f528dcb3a626f3e91534d80c59b9440385' },
  bnb: { address: '0x4848489f0b2bedd788c696e2d79b6b69d7484848', tx: '0x0982d3d27997b552d00f5ea70626052fbb0ba99c9914b9f66dcbbda89dbb4e13' },
  avalanche: { address: '0x995be1ca945174d5ba75410c1e658a41eb13a2fa', tx: '0x9ab09bd15683efb94858ec2e0dc3609c849af6250ed231f8062977c2111c0636' },
  scroll: { address: '0x831e58290be683a0ac26c424d4831f7072dd8960', tx: '0xe8be4457d1327cd36d07e08bb57490de2f1bc8b2e91146137dea41f499488ce1' },
  berachain: { address: '0xb8cc9edca17f9b875f58770193069aa788afeb68', tx: '0x28fdd09caf98395aed98cb4547c510751dda179a56f049881bfff853843ff707' },
  monad: { address: '0x6f49a8f621353f12378d0046e7d7e4b9b249dc9e', tx: '0x3fe3136305364b3e0e6dd5664aee7268e9a9e6e715137cfc7b598931894099ab' },
  xlayer: { address: '0x10be12df37e2dcb16a7a9c18897730ca93ab2351', tx: '0x27ef092c9d18a52fab43f474a12aa762f643006910ba80586ae67f72582db55f' },
  plasma: { address: '0x8192bf75cb263e543c4f2c06edb983139034aa0f', tx: '0x13c8d1c88d29c18e74492a13a7a39bce368d04e583db8ac966b7e0a8d90284c7' },
  robinhood: { address: '0x6abea4998f9ef34ee1cda5715ccca0e4d4efb730', tx: '0x3c2331f2ec3903724ebfd622bbd116148a2bda9cf39d6ba16b9905dcecae380e' },
  adi: { address: '0xc303653623240ef172926e54e02ac5f8abca1a7e', tx: '0xbd3958ff02027a51569f1c21a0e69cd19c79ce0b863c8feef877761b25e45dff' },
  abstract: { address: '0x3f064dfdbde340f87944ca481e1ba6b448f824fa', tx: '0x768f34c44582a7fc18e7f1c52e508fae5f91573141402440b9a1227675bf8ad1' },
  hypercore: { address: '0xac487c027ffe32021bbba77e30786f8c8f353201', tx: '0x2e4667ba841af8b12fc004454b56f30202c200a01f1e1783d20f130d431ed29b' },
  fogo: { address: 'Liq5WtY55dWVgyUnwVSUneAWx5KF96ycnbv5DaTW5Ww', tx: 'vfMydTVszQJtB1zNYGYFNqFm2bqvLHwLTmomZbjnteaPPvdaDmfunQCRvCwuQzM5jMCqPBqtJB3UBUM3hDuP3Go' },
  litecoin: { address: 'LMyZuSZ19kzqDW11D2gbA5TgyP6jnjEZKt', tx: '68a604e3579424305614eb07869139df2a5c9a158a4a0e98c62f6461ad3c9724' },
  bitcoincash: { address: 'bitcoincash:qrcuqadqrzp2uztjl9wn5sthepkg22majyxw4gmv6p', tx: '13acf8ceaf9f5d8e32361a28392becbf3feeb2b593f6b35bd32ff36cf1933dca' },
  dogecoin: { address: 'DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L', tx: 'f7f07e2b888cdb0cb0de8ebcaf39a3f8c5422160f9c1d98001033e0540592897' },
  dash: { address: 'XcQi5LrrgGP1BUzSSymggXEyetAP1HH1Sf', tx: '6b84b20907756c4be508a73fb9abadebb98779beb6c8eac62c8d19132688aad7' },
  zcash: { address: 't1ftzLVzeo23g6Bm8gv4K1yj7ip6RX7eRQf', tx: null },
  xrp: { address: 'rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh', tx: '007DB4DA82228D6FEDD94C72E736D6B49CDAA63B3B316A57A5CC82C17ACCC700' },
  ton: { address: 'EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N', tx: 'cieoCGqvUTuB6ra6D9OJRM+h6SnGOgBsZtmqC5K0me8=' },
  tron: { address: 'TCw6YaWm3y6DvxY7M8hrCDnrJGeGMumzGJ', tx: '0d5f10a46f0d71fecba5fa19fc555388fd35f1ab9d059e2a793ac0a1c90dfb8c' },
  sui: { address: '0x34729f8dd6d4e9bf5243b327c6462552a2d092808c537b9bbae7ee1a0e080a39', tx: '5rUBM925nTuZVqLN99g9TRoR8WYi3bWrimNcMkfgkKpi' },
  aptos: { address: '0xd503b95164384a5ebbccbb5c4bdc8b4a5893d9651e9953abda8e1c22fcc1181d', tx: '0xf73224c5e8676111cc26cb38b0ae2d7be81a0c9ed4ca4e62767548ae13e02824' },
  movement: { address: '0x28d7c00a7b57148312bd9a44c020e9a1763fb41658d412f9817b5c1d9c12dbf3', tx: '0xdeb99ca7ed0b2f57ad2bcb85ba697306d96db193276f0cba02f97ddc458e679d' },
  cardano: { address: 'addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x', tx: '50c13ecc7b73ce186f4a70a9bf691c3e745b28a63348b4bb82a0ab80086ee40f' },
  stellar: { address: 'GDJ4JZXZELZD737NVFORH4PSSQDWFDZTKW3AIDKHYQG23ZXBPDGGQBJK', tx: '27d5a9d7f9874932e163ce3cf97e7317c62059ed4e7abfb8ed07e4c1fc6b112c' },
  starknet: { address: '0x4678eb497e96599c92b45f342c2bd284321fe219c60a9b6293d80f0fbfa61b5', tx: '0x492e0d1794ac2f17437c82fabf003674f5e2ed8ab8248d0fee74f78ab4d6d15' },
  aleo: { address: 'aleo1anfvarnm27e2s5j6mzx3kzakx5eryc69re96x6grzkm9nkapkgpq4vyy5t', tx: 'at1slsjfd5pdpyksvzd0y7n3zs9g2lxgh86rmvtk7xuzzcatlz0ssrsg4t2gv' },
};

function cell(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}~` : text.padEnd(width);
}

async function row(network: ChainNetwork): Promise<string> {
  const sample = SAMPLES[network];
  // A fresh cache per network, the app's own buckets per host, and a minute each.
  const deps = { state: createChainFetchState(), deadline: Date.now() + 60_000 };
  const [head, activity, tx] = await Promise.all([
    chainHead(network, deps),
    addressActivity(network, sample.address, deps),
    sample.tx === null ? Promise.resolve(null) : transaction(network, sample.tx, deps),
  ]);
  const headText = head === null ? 'no head' : `${head.height} ${head.ageSec === null ? 'age n/a' : `${head.ageSec}s`}`;
  const balance = activity.ok ? `${activity.balance?.amount ?? '?'} ${activity.balance?.symbol ?? ''}`.trim() : `not read: ${activity.error ?? ''}`;
  const count = activity.txCount === null ? '-' : String(activity.txCount);
  const status = tx === null ? '-' : tx.ok ? `${tx.tx?.status}${tx.tx?.block === null || tx.tx?.block === undefined ? '' : ` @${tx.tx.block}`}` : `not read: ${tx.error ?? ''}`;
  return `${cell(network, 12)} ${cell(NETWORKS[network].read ?? 'none', 11)} ${cell(headText, 22)} ${cell(balance, 34)} ${cell(count, 9)} ${status}`;
}

const asked = process.argv.slice(2).filter(isChainNetwork);
const networks = asked.length > 0 ? asked : [...CHAIN_NETWORKS];
console.log(`${cell('network', 12)} ${cell('reader', 11)} ${cell('head (age)', 22)} ${cell('balance', 34)} ${cell('txCount', 9)} tx status`);
// Six at a time: every network has its own host, so the only shared limit is this machine.
for (let i = 0; i < networks.length; i += 6) {
  for (const line of await Promise.all(networks.slice(i, i + 6).map(row))) console.log(line);
}
