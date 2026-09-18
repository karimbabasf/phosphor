#!/usr/bin/env node
// THE SEAT A CARD LANDS IN, with nobody sitting in it.
//
// Every card in this app is tagged with a conversation. src/driver.ts hands one to the chat its
// child is in, and src/http/view.ts draws a `show` card by pushing it into every chat the window
// has open; with none open the tool answers drawn:false and says so, which is right and is not a
// state any person is in while they are typing at it. This harness runs the agent beside the app
// rather than inside it, so nothing had opened a conversation. scripts/eval.ts presses the plus
// the way the window does, and that door starts a child. This is that child: it holds the seat
// and answers nothing, so no second model runs beside the one under test.
process.stdin.resume();
