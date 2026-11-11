# Seattle Source checker architecture

The checker reads school records through existing parent accounts and turns
changes into a weekday update and a Friday family report. The current system
runs on a Mac. The proposed web app works on phones and computers and
supports multiple children and separate family accounts.

- [Current architecture and C4 views](current.md)
- [Architecture description language (ADL)](system.adl.json)
- [Quality attribute assessment](quality.md)
- [Cloudflare architecture and migration plan](cloudflare.md)
- [Decision records](adr/README.md)

The ADL is a lightweight JSON architecture model. It describes system
boundaries, components, relationships, and active integrations. C4 diagrams
are maintained alongside it in Markdown. Decision records distinguish
accepted scope from proposed implementation choices.
