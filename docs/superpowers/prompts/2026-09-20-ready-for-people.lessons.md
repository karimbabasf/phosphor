# Ready for people: lessons

One line per lesson: what bit, and the rule. Only what the repo, the vault note and the builder prompt do not already record. Teammates append; the lead reads it before every new brief.

- [2026-09-20] The automation Brave is one daemon for every agent on this Mac: a browser-use call without switch_tab lands in whichever tab is active, and one reviewer finished another reviewer's onboarding walk (port 4215) by accident. Rule: every browser-driving brief says switch_tab to your own tab (by URL) before every call, and one backend port per agent.
- [2026-09-20] browser-use supports a per-agent daemon: BU_NAME=<name> gives an agent its own browser session, so trusted clicks from a peer never land on its tab. Every browser-driving brief should set BU_NAME to the agent's name (the C reviewer redid its walk clean that way).
