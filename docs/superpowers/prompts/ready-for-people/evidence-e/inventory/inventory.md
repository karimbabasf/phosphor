# Button inventory

105 sites, 54 families, scanned from ui/screens/*.js, ui/*.js and ui/index.html on 2026-09-21.


| Family | Sites | Label source | Waits | Disables | States drawn | Measured |
| --- | --- | --- | --- | --- | --- | --- |
| `activity-link` | screens/receipts.js:394 | label (argument) | no | no | hover, active, focus, pending | 860: h 30 ok<br>400: h 30 ok |
| `btn` | screens/decision.js:1096 | "Got it" | Filing | no | hover, active, disabled, focus, pending | 860: h 36 ok<br>400: h 36 ok |
| `btn btn-danger` | screens/agent.js:927, screens/vault.js:245 | "Turn off"; "Forget this wallet" | Waiting for Touch ID | no | hover, active, disabled, focus, pending | 860: h 36 ok<br>400: h 36 ok |
| `btn btn-ghost` | screens/agent.js:563, screens/agent.js:926, screens/decision.js:632, screens/decision.js:657, screens/feedback.js:55, screens/feedback.js:149, screens/firstrun.js:341, screens/firstrun.js:666, screens/firstrun.js:668, screens/firstrun.js:844, screens/netpick.js:1128, screens/receipt.js:409, screens/receipt.js:598, screens/vault.js:161, screens/vault.js:166, screens/vault.js:167, screens/vault.js:775, screens/vault.js:851, screens/vault.js:922 | "Connect your own"; "Keep running"; "No"; "Cancel"; "Back"; "Copy"; "Print"; "Show the address"; "Check it again"; "Close"; "Restore from a phrase"; "Show my recovery words"; "Save an encrypted backup"; "Show the words again" | Refusing, Checking | no | hover, active, disabled, focus, pending | 860: h 36 ok<br>400: h 36 ok |
| `btn btn-ghost activity-more` | screens/receipts.js:351 | "See all" | no | no | hover, active, disabled, focus, pending | 860: h 40 ok<br>400: h 40 ok |
| `btn btn-ghost btn-lg` | screens/firstrun.js:355 | primaryLabel (argument) | no | yes | hover, active, disabled, focus, pending | 860: h 44 ok<br>400: h 44 ok |
| `btn btn-ghost btn-sm` | screens/netpick.js:1212, screens/netpick.js:1325, screens/vault.js:670 | "Try again"; "Copy memo"; "Copy" | no | no | hover, active, disabled, focus, pending | 860: h 30 ok<br>400: h 30 ok |
| `btn btn-ghost btn-sm agent-connect-back` | screens/agent.js:604 | "Back" | no | no | hover, active, disabled, focus, pending | 860: h 30 ok<br>400: h 30 ok |
| `btn btn-ghost btn-sm tcard-open` | screens/cards.js:1235 | "Open the deposit card" | no | no | hover, active, disabled, focus, pending | 860: h 30 ok<br>400: h 30 ok |
| `btn btn-ghost btn-sm trade-more` | screens/trade.js:200 | "Show more" | no | no | hover, active, disabled, focus, pending | 860: h 30 ok<br>400: h 30 ok |
| `btn btn-ghost trade-act` | screens/trade.js:1861 | built by the caller | no | no | hover, active, disabled, focus, pending, on | 860: h 36 ok<br>400: h 36 ok |
| `btn btn-primary` | screens/agent.js:562, screens/decision.js:635, screens/decision.js:660, screens/decision.js:1092, screens/deposit.js:278, screens/feedback.js:57, screens/feedback.js:152, screens/firstrun.js:830, screens/moneyin.js:113, screens/receipt.js:568, screens/vault.js:137, screens/vault.js:160, screens/vault.js:776, screens/vault.js:852, screens/vault.js:923 | "Start your assistant"; "Unlock"; send (argument); "Reconcile"; "Back up now"; "Yes"; "Continue"; "Start it"; "Done"; "Check it again"; "Move behind the Secure Enclave"; "Reveal recovery phrase"; "I wrote them down"; "Prove it"; "Restore" | Starting, Approving, Checking, Waiting for Touch ID, Restoring | no | hover, active, disabled, focus, pending | 860: h 36 ok<br>400: h 36 ok |
| `btn btn-primary btn-lg` | screens/firstrun.js:355, screens/lock.js:430, screens/lock.js:491, screens/terms.js:118, screens/vault.js:1056 | primaryLabel (argument); "Encrypt now"; "Continue"; "Accept and continue"; "Move my keys" | Encrypting your keys, Saving, Waiting for Touch ID | yes | hover, active, disabled, focus, pending | 860: h 44 ok<br>400: h 44 ok |
| `btn btn-primary btn-sm` | screens/agent.js:497 | "Start your assistant" | Starting | no | hover, active, disabled, focus, pending | 860: h 30 ok<br>400: h 30 ok |
| `btn btn-primary lock-unlock` | screens/lock.js:261, screens/lock.js:330 | "Unlock"; "Unlock with Touch ID" | Unlocking, Waiting for Touch ID | no | hover, active, disabled, focus, pending | 860: h 48 ok<br>400: h 48 ok |
| `btn btn-quiet` | screens/firstrun.js:347, screens/receipt.js:623, screens/vault.js:201, screens/vault.js:777 | opts.skip (argument); "Copy"; "Your rules"; "Done" | no | no | hover, active, disabled, focus, pending | 860: h 36 ok<br>400: h 36 ok |
| `btn btn-quiet btn-sm` | screens/agent.js:498, screens/deposit.js:175, screens/netpick.js:554 | "Turn off"; "Close"; "Stop watching" | Turning off, Stopping | no | hover, active, disabled, focus, pending | 860: h 30 ok<br>400: h 30 ok |
| `btn btn-quiet btn-sm receipt-copy` | screens/receipt.js:260 | "Copy" | no | no | hover, active, disabled, focus, pending | 860: h 30 ok<br>400: h 30 ok |
| `btn btn-quiet btn-sm sendcard-copy` | screens/sendcard.js:358 | "Copy" | no | no | hover, active, disabled, focus, pending | 860: h 30 ok<br>400: h 30 ok |
| `btn btn-sm freeze` | index.html:92 | "Freeze everything" | no | no | hover, active, disabled, focus, pending | 860: h 30 ok<br>400: h 30 ok |
| `check-row layers-row` | screens/shell.js:478, screens/trade.js:573 | pane.label (argument); label (argument) | no | no | hover, active, focus, pending, on | 860: h 30 ok<br>400: h 30 ok |
| `checks-toggle` | screens/checks.js:199 | "Checks" | no | no | hover, active, focus, pending | 860: h 32 ok<br>400: h 32 ok |
| `chip` | screens/firstrun.js:901, screens/vault.js:215 | built by the caller; minutes (argument) | Saving | no | hover, active, focus, pending, on | 860: h 30 ok<br>400: h 30 ok |
| `chip agent-retry` | screens/agent.js:520 | "Retry" | Starting | no | hover, active, focus, pending, on | 860: h 30 ok<br>400: h 30 ok |
| `chip chip-filter` | screens/receipts.js:124 | item.label (argument) | no | no | hover, active, focus, pending, on | 860: h 30 ok<br>400: h 30 ok |
| `chip connection-copy` | screens/agent.js:594 | "Copy" | no | no | hover, active, focus, pending, on | 860: h 30 ok<br>400: h 30 ok |
| `chip suggest` | screens/agent.js:576 | SUGGESTIONS[s] (argument) | no | no | hover, active, focus, pending, on | 860: h 32 ok<br>400: h 32 ok |
| `choice` | screens/firstrun.js:586 | title (argument) | no | no | hover, active, focus, pending, on | 860: h 79 ok<br>400: h 79 ok |
| `composer-send` | screens/agent.js:666 | aria-label "Send" | no | no | hover, active, disabled, focus, pending, on | 860: h 36 ok<br>400: h 36 ok |
| `dock-close` | screens/deposit.js:267 | aria-label "Not now" | no | no | hover, active, focus, pending | 860: h 30 ok<br>400: h 30 ok |
| `dock-next` | screens/decision.js:605 | entry.queued (argument) | no | no | hover, active, focus, pending | 860: h 30 ok<br>400: h 30 ok |
| `dock-report-toggle` | screens/decision.js:958 | word (argument) | no | no | hover, active, focus, pending | 860: h 32 ok<br>400: h 32 ok |
| `fold-head card-head` | screens/basic.js:194 | title (argument) | no | no | hover, active, focus, pending, on | 860: h 52 ok<br>400: h 52 ok |
| `holding-head` | screens/pro.js:378 | built by the caller | no | no | hover, active, focus, pending, on | 860: h 53 ok<br>400: h 53 ok |
| `jump-latest` | screens/agent.js:636 | "Jump to latest" | no | no | hover, active, focus, pending | 860: h 32 ok<br>400: h 32 ok |
| `layers opens` | screens/trade.js:595 | "Layers" | no | no | hover, active, focus, pending | 860: h 30 ok<br>400: h 30 ok |
| `layout opens` | index.html:84 | "Layout" | no | no | hover, active, focus, pending | 860: h 30 ok<br>400: h 30 ok |
| `lock-eye` | screens/lock.js:240 | aria-label "Show password" | no | no | hover, active, focus, pending, on | 860: h 36 ok<br>400: h 36 ok |
| `net-row` | screens/netpick.js:878 | n.name (argument) | no | no | hover, active, focus, pending, on | 860: h 52 ok<br>400: h 52 ok |
| `net-tile` | screens/netpick.js:746 | n.name (argument) | no | no | hover, active, focus, pending, on | 860: h 84 ok<br>400: h 84 ok |
| `netpick-back` | screens/netpick.js:930 | "Change network" | no | no | hover, active, focus, pending | 860: h 30 ok<br>400: h 30 ok |
| `netpick-link` | screens/netpick.js:788, screens/netpick.js:1366 | built by the caller; " " | no | no | hover, active, focus, pending | 860: h 30 ok<br>400: h 30 ok |
| `netsel` | screens/vault.js:472 | aria-label "Which network" | no | no | hover, active, focus, pending, on | 860: h 40 ok<br>400: h 40 ok |
| `pane-hide` | split.js:473 | aria-label "Hide the " | no | no | hover, active, focus, pending | 860: h 30 ok<br>400: h 30 ok |
| `pane-show` | split.js:496 | aria-label "Show the " | no | no | hover, active, focus, pending | 860: h 30 ok<br>400: h 30 ok |
| `receipt-close` | screens/receipt.js:345 | aria-label "Close" | no | no | hover, active, focus, pending | 860: h 32 ok<br>400: h 32 ok |
| `rule-group-title opens` | screens/pro.js:979 | title (argument) | no | no | hover, active, focus, pending, on | 860: h 30 ok<br>400: h 30 ok |
| `sendcard-info` | screens/sendcard.js:247 | "i" | no | no | hover, active, focus, pending | 860: h 30 ok<br>400: h 30 ok |
| `status-line bar-state` | index.html:71 | "Not backed up" | no | no | hover, active, focus, pending | 860: h 30 ok<br>400: h 30 ok |
| `steps-fold` | screens/agent.js:1559 | icon chevron | no | no | hover, active, focus, pending, on | 860: h 30 ok<br>400: h 30 ok |
| `tab` | index.html:55, index.html:56, index.html:57, index.html:58 | "Basic"; "Pro"; "Trade"; "Vault" | no | no | hover, active, focus, pending, on | 860: h 30 ok<br>400: h 30 ok |
| `trade-symbol opens` | screens/trade.js:668 | aria-label "Which market" | no | no | hover, active, disabled, focus, pending | 860: h 32 ok<br>400: h 32 ok |
| `trade-tab` | screens/trade.js:357 | TABS (argument) | no | no | hover, active, focus, pending, on | 860: h 35 ok<br>400: h 35 ok |
| `tx receipt-row` | screens/receipt.js:669 | "" | no | no | hover, active, focus, pending | 860: h 66 ok<br>400: h 86 ok |
