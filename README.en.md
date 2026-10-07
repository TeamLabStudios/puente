<p align="center"><img src="build/icon.png" width="96" alt="Puente"></p>

<h1 align="center">Puente</h1>

<p align="center">
  <b>Send files between your Windows PCs and your Android phone — at home or away — end-to-end encrypted.</b><br>
  No cloud. No accounts. No third-party servers.
</p>

<p align="center"><a href="README.md">Español</a> · <a href="PROTOCOLO.md">Protocol & security (ES)</a> · <a href="https://github.com/TeamLabStudios/puente/releases/latest">Download</a></p>

<p align="center"><img src="docs/img/pc-emparejar-qr.jpg" alt="Puente on Windows" width="900"></p>

> The app UI is in Spanish ("puente" means *bridge*). The protocol and code are documented, tested and MIT-licensed.

## Why Puente

- 🔐 **Noise XX + AES-256-GCM** on every connection (the framework behind WireGuard and WhatsApp's transport), fresh keys every time, tampering detected and dropped.
- 🔢 **6-digit SAS check** when pairing, derived from the handshake hash: if both screens match, nobody is in the middle. Pair once, recognised forever.
- 🏠 **Home and away**: direct on your LAN; outside, through a **relay you control** (your own home PC can be the relay with one toggle). The relay only ever sees ciphertext.
- 📱 **PC ↔ Android** with the same protocol, byte for byte: share sheet, Accept/Reject from the notification, files land in *Downloads › Puente*.
- 🕶️ **Private session**: received files skip Downloads and history and **self-destruct** after N minutes.
- 🧯 **Panic button**: kills every connection and transfer and wipes private files.
- 🧹 **Delete from the phone after sending** (optional), only once the PC confirms every file's SHA-256.
- ♻️ **Resumable** transfers, whole folders, thousands of files.

## How it compares

Based on each project's documentation (October 2026):

| | **Puente** | LocalSend | PairDrop | Magic Wormhole |
|---|---|---|---|---|
| Works outside your network | ✅ own relay | ❌ LAN only | ✅ via its server + TURN | ✅ via its servers |
| Needs a third-party server | **No** | No | Yes (or self-host) | Yes by default (or self-host) |
| MITM check | **6-digit SAS** from the handshake | cert fingerprint / optional PIN | pairing key via server | one-time code (PAKE) |
| Remembers devices | ✅ | ✅ | ✅ | ❌ |
| Self-destructing private session | ✅ | — | — | — |
| Panic button | ✅ | — | — | — |
| Platforms | Windows, Android | Win, macOS, Linux, Android, iOS | browser | CLI |

Honestly: for quick LAN transfers across many OSes, LocalSend is more mature. Puente is for the same experience **at home and away, with no one else's server, a verified pairing and full control over what is kept**.

<p align="center"><img src="docs/img/android.jpg" alt="Puente for Android" width="900"></p>

## Security

Full spec and threat model: [PROTOCOLO.md](PROTOCOLO.md) (Spanish). Noise verified against the official test vectors, X25519 against RFC 7748, Android tested against the real desktop engine, fuzzing of names/paths/hostile peers. Young project (0.x), not yet independently audited — reports welcome via [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © TeamLabStudios
