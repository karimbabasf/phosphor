// The shell's watch on the person stepping away from this Mac: the screen locking, and the Mac
// switching to another user's session. Objective-C because both arrive through Foundation and
// AppKit notification centres; the `cc` crate compiles it beside xpc_bridge.c. What happens next
// is src/session_watch.rs.
//
// Both observers run on one private serial queue and never on the main thread: a lock is a socket
// round trip, and the main thread draws the window. A distributed notification reaches a queue
// observer without anyone spinning a run loop for it, which is also what lets a test drive this.

#import <AppKit/AppKit.h>

typedef void (*phosphor_session_event)(int kind);

enum { PHOSPHOR_SCREEN_LOCKED = 1, PHOSPHOR_SESSION_RESIGNED = 2 };

// `screen_locked` is the distributed notification macOS posts to every app when the screen
// locks, com.apple.screenIsLocked. `addressed` is the same signal addressed to this one shell by
// its process id: a test posts that one, so a test run never tells every app on the Mac that the
// screen locked.
void phosphor_watch_session(const char *screen_locked, const char *addressed, phosphor_session_event on_event) {
    NSOperationQueue *queue = [[NSOperationQueue alloc] init];
    queue.maxConcurrentOperationCount = 1;
    queue.name = @"com.karimbabasf.phosphor.session-watch";
    for (NSString *name in @[ [NSString stringWithUTF8String:screen_locked], [NSString stringWithUTF8String:addressed] ]) {
        [[NSDistributedNotificationCenter defaultCenter] addObserverForName:name
                                                                     object:nil
                                                                      queue:queue
                                                                 usingBlock:^(NSNotification *note) {
                                                                   (void)note;
                                                                   on_event(PHOSPHOR_SCREEN_LOCKED);
                                                                 }];
    }
    [[[NSWorkspace sharedWorkspace] notificationCenter] addObserverForName:NSWorkspaceSessionDidResignActiveNotification
                                                                     object:nil
                                                                      queue:queue
                                                                 usingBlock:^(NSNotification *note) {
                                                                   (void)note;
                                                                   on_event(PHOSPHOR_SESSION_RESIGNED);
                                                                 }];
}

// What AppKit posts in this process when the session moves to another user, for the tests: a
// real user switch cannot be scripted, and this is the notification it arrives as.
void phosphor_post_session_resigned(void) {
    [[[NSWorkspace sharedWorkspace] notificationCenter] postNotificationName:NSWorkspaceSessionDidResignActiveNotification
                                                                     object:nil];
}
